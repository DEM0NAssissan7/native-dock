import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Layout from "resource:///org/gnome/shell/ui/layout.js";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";

const DummyDash = GObject.registerClass(
  class DummyDash extends Clutter.Actor {
    _init(realDash) {
      super._init({ visible: false });
      this._realDash = realDash;
    }

    setMaxSize(maxWidth, maxHeight) {
      this._realDash?.setMaxSize(maxWidth, maxHeight);
    }

    vfunc_get_preferred_height(forWidth) {
      if (!this._realDash) return [0, 0];
      return this._realDash.get_preferred_height(forWidth);
    }

    vfunc_get_preferred_width(forHeight) {
      if (!this._realDash) return [0, 0];
      return this._realDash.get_preferred_width(forHeight);
    }
  },
);

export default class NativeDockExtension extends Extension {
  enable() {
    this._dash = null;
    this._dockBox = null;
    this._dummyDash = null;
    this._origParent = null;
    this._origLayoutDash = null;
    this._origItemMenuStateChanged = null;
    this._showAppsId = null;
    this._focusWindow = null;
    this._pressureBarrier = null;
    this._barrier = null;
    this._revealed = false;
    this._menuOpen = false;
    this._hideTimeoutId = 0;
    this._revealTimeoutId = 0;
    this._idleCheckId = 0;
    this._stateTimeoutId = 0;
    this._dockTargetHidden = null;
    this._overviewWasShown = false;
    this._overviewHiding = false;
    this._dockWasHiddenOnOverviewEnter = false;

    if (Main.layoutManager._startingUp) {
      Main.layoutManager.connectObject(
        "startup-complete",
        () => this._initDock(),
        this,
      );
    } else {
      this._initDock();
    }
  }

  _initDock() {
    Main.layoutManager.disconnectObject(this);

    const controls = Main.overview._overview?._controls;
    const dash = Main.overview.dash;

    if (!controls || !dash) return;

    this._dash = dash;
    this._origParent = this._dash.get_parent();

    // 1. Create the dock container box spanning the bottom of the screen
    this._dockBox = new St.Widget({
      name: "native-dock-box",
      layout_manager: new Clutter.BinLayout(),
      reactive: false,
    });

    // 2. Remove dash from ControlsManager and insert DummyDash in its place so
    // ControlsManagerLayout reserves the correct native height for overview workspaces.
    if (this._origParent) this._origParent.remove_child(this._dash);

    this._dummyDash = new DummyDash(this._dash);
    controls.add_child(this._dummyDash);

    this._origLayoutDash = controls.layout_manager._dash;
    controls.layout_manager._dash = this._dummyDash;

    // 3. Add dash to our dock box centered horizontally and aligned to bottom
    this._dash.x_align = Clutter.ActorAlign.CENTER;
    this._dash.y_align = Clutter.ActorAlign.END;
    this._dash.reactive = true;
    this._dash.track_hover = true;
    this._dockBox.add_child(this._dash);

    // 4. Add dock box to Chrome (above windows)
    Main.layoutManager.addTopChrome(this._dockBox, {
      trackFullscreen: true,
    });

    // 5. Intercept context menu state to prevent dock hiding while menu is open
    this._origItemMenuStateChanged = this._dash._itemMenuStateChanged?.bind(
      this._dash,
    );
    this._dash._itemMenuStateChanged = (item, opened) => {
      this._origItemMenuStateChanged?.(item, opened);
      this._menuOpen = opened;
      if (!opened && !this._isHovered()) this._queueHide();
    };

    // 6. Connect hover signal to manage auto-hiding when revealed
    this._dash.connectObject(
      "notify::hover",
      () => this._onHoverChanged(),
      this,
    );
    this._dash.connectObject(
      "notify::height",
      () => this._updatePosition(),
      this,
    );

    // 7. Track window focus, maximize, tile, resize, minimize, destroy, and workspace changes
    global.display.connectObject(
      "notify::focus-window",
      () => this._onFocusWindowChangedDelayed(),
      "restacked",
      () => this._onFocusWindowChangedDelayed(),
      "in-fullscreen-changed",
      () => this._onFocusWindowChangedDelayed(),
      "grab-op-end",
      () => this._onFocusWindowChangedDelayed(),
      "window-created",
      () => this._onFocusWindowChangedDelayed(),
      "window-visibility-updated",
      () => this._onFocusWindowChangedDelayed(),
      this,
    );
    global.window_manager.connectObject(
      "size-changed",
      () => this._onFocusWindowChangedDelayed(),
      "size-change",
      () => this._onFocusWindowChangedDelayed(),
      "minimize",
      () => this._onFocusWindowChangedDelayed(),
      "unminimize",
      () => this._onFocusWindowChangedDelayed(),
      "destroy",
      () => this._onFocusWindowChangedDelayed(),
      "map",
      () => this._onFocusWindowChangedDelayed(),
      "switch-workspace",
      () => this._onWorkspaceChanged(),
      this,
    );
    global.workspace_manager.connectObject(
      "active-workspace-changed",
      () => this._onWorkspaceChanged(),
      this,
    );

    // 8. Synchronize dock animation with native overview transitions & gestures
    if (controls._stateAdjustment) {
      controls._stateAdjustment.connectObject(
        "notify::value",
        () => {
          if (Main.overview.visible || Main.overview._animationInProgress) {
            const progress = Math.clamp(controls._stateAdjustment.value, 0, 1);
            const shouldHide = this._shouldHideForFocusedWindow();
            const isClosing =
              this._overviewHiding || (this._overviewWasShown && progress < 1);

            if (!shouldHide) {
              // Returning to or opening from a normal window or empty desktop:
              // Pre-emptively keep dock visible throughout!
              this._dockBox.remove_all_transitions();
              this._dockBox.translation_y = 0;
              this._dockBox.opacity = 255;
            } else if (isClosing || this._dockWasHiddenOnOverviewEnter) {
              // Exiting to a maximized/tiled window, or entering when dock was hidden:
              // Dock moves 1:1 with overview animation
              this._dockBox.remove_all_transitions();
              this._dockBox.translation_y = Math.round(
                (1 - progress) * this._dockBox.height,
              );
              this._dockBox.opacity = Math.round(progress * 255);
            } else {
              // Entering overview when dock was already revealed on desktop
              this._dockBox.remove_all_transitions();
              this._dockBox.translation_y = 0;
              this._dockBox.opacity = 255;
            }
          }
        },
        this,
      );
    }

    Main.overview.connectObject(
      "showing",
      () => this._onOverviewShowing(),
      "shown",
      () => {
        this._overviewWasShown = true;
        this._overviewHiding = false;
      },
      "hiding",
      () => {
        this._overviewHiding = true;
      },
      "hidden",
      () => this._onOverviewHidden(),
      this,
    );

    Main.layoutManager.connectObject(
      "monitors-changed",
      () => this._updatePosition(),
      this,
    );

    // 9. Connect Show Applications button to open App Grid when clicked on desktop
    this._showAppsId = this._dash.showAppsButton.connect(
      "notify::checked",
      () => {
        if (this._dash.showAppsButton.checked && !Main.overview.visible)
          Main.overview.showApps();
      },
    );

    this._updatePosition();
    this._onFocusWindowChangedDelayed();
  }

  _updatePosition() {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor || !this._dash || !this._dockBox) return;

    const maxDashHeight = Math.round(monitor.height * 0.16);
    this._dash.setMaxSize(monitor.width, maxDashHeight);

    const [, prefHeight] = this._dash.get_preferred_height(monitor.width);
    const dockHeight = prefHeight > 0 ? prefHeight : 64;

    this._dockBox.set_position(
      monitor.x,
      monitor.y + monitor.height - dockHeight,
    );
    this._dockBox.set_size(monitor.width, dockHeight);

    this._initBarrier();
    this._updateVisibility(true);
  }

  _initBarrier() {
    this._destroyBarrier();

    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor) return;

    this._pressureBarrier = new Layout.PressureBarrier(
      100,
      1000,
      Shell.ActionMode.NORMAL,
    );
    this._pressureBarrier.connect("trigger", () => this._onPressureTrigger());

    try {
      this._barrier = new Meta.Barrier({
        backend: global.backend,
        x1: monitor.x,
        x2: monitor.x + monitor.width,
        y1: monitor.y + monitor.height,
        y2: monitor.y + monitor.height,
        directions: Meta.BarrierDirection.NEGATIVE_Y,
      });
      this._pressureBarrier.addBarrier(this._barrier);
    } catch (e) {
      console.error(`NativeDock: Failed to create barrier: ${e.message}`);
    }
  }

  _destroyBarrier() {
    if (this._barrier) {
      if (this._pressureBarrier)
        this._pressureBarrier.removeBarrier(this._barrier);
      this._barrier.destroy();
      this._barrier = null;
    }
    if (this._pressureBarrier) {
      this._pressureBarrier.destroy();
      this._pressureBarrier = null;
    }
  }

  _getFocusedOrTopWindow() {
    const activeWorkspace = global.workspace_manager.get_active_workspace();
    if (!activeWorkspace) return null;

    const focusWindow = global.display.focus_window;
    if (
      focusWindow &&
      !focusWindow.minimized &&
      focusWindow.is_on_primary_monitor() &&
      focusWindow.get_window_type() !== Meta.WindowType.DESKTOP &&
      (focusWindow.located_on_workspace
        ? focusWindow.located_on_workspace(activeWorkspace)
        : true)
    ) {
      return focusWindow;
    }

    const windows = activeWorkspace.list_windows();
    const sorted = global.display.sort_windows_by_stacking(windows).reverse();
    return (
      sorted.find(
        (w) =>
          w.is_on_primary_monitor() &&
          !w.minimized &&
          w.get_window_type() !== Meta.WindowType.DESKTOP &&
          (w.located_on_workspace
            ? w.located_on_workspace(activeWorkspace)
            : true),
      ) || null
    );
  }

  _shouldHideForFocusedWindow() {
    const window = this._getFocusedOrTopWindow();
    if (!window) return false;

    // 1. Fullscreen
    if (window.is_fullscreen()) return true;

    // 2. Maximized (vertically or horizontally)
    if (window.maximized_vertically || window.maximized_horizontally)
      return true;

    // 3. Tiled
    if (
      window.get_tile_match?.() !== null &&
      window.get_tile_match?.() !== undefined
    )
      return true;

    // 4. Modal dialogs
    if (
      window.get_window_type() === Meta.WindowType.MODAL_DIALOG ||
      window.is_attached_dialog?.()
    )
      return true;

    // 5. Dialogs or popups transient for a maximized, tiled, or fullscreen window
    let parent = window.get_transient_for?.();
    while (parent) {
      if (
        parent.is_fullscreen() ||
        parent.maximized_vertically ||
        parent.maximized_horizontally ||
        (parent.get_tile_match?.() !== null &&
          parent.get_tile_match?.() !== undefined)
      )
        return true;
      parent = parent.get_transient_for?.();
    }

    return false;
  }

  _onFocusWindowChanged() {
    const window = this._getFocusedOrTopWindow();

    if (this._focusWindow !== window) {
      if (this._focusWindow) this._focusWindow.disconnectObject(this);

      this._focusWindow = window;

      if (this._focusWindow) {
        this._focusWindow.connectObject(
          "notify::maximized-horizontally",
          () => this._onFocusWindowChangedDelayed(),
          "notify::maximized-vertically",
          () => this._onFocusWindowChangedDelayed(),
          "notify::minimized",
          () => this._onFocusWindowChangedDelayed(),
          "notify::fullscreen",
          () => this._onFocusWindowChangedDelayed(),
          "size-changed",
          () => this._onFocusWindowChangedDelayed(),
          "unmanaging",
          () => {
            this._focusWindow = null;
            this._onFocusWindowChangedDelayed();
          },
          this,
        );
      }
    }

    this._updateVisibility();
  }

  _onFocusWindowChangedDelayed() {
    this._revealed = false;
    this._onFocusWindowChanged();

    if (this._idleCheckId) GLib.source_remove(this._idleCheckId);

    this._idleCheckId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
      this._idleCheckId = 0;
      this._onFocusWindowChanged();
      return GLib.SOURCE_REMOVE;
    });
  }

  _onWorkspaceChanged() {
    this._revealed = false;
    this._onFocusWindowChangedDelayed();
  }

  _onOverviewShowing() {
    if (this._hideTimeoutId) {
      GLib.source_remove(this._hideTimeoutId);
      this._hideTimeoutId = 0;
    }
    if (this._revealTimeoutId) {
      GLib.source_remove(this._revealTimeoutId);
      this._revealTimeoutId = 0;
    }
    if (this._idleCheckId) {
      GLib.source_remove(this._idleCheckId);
      this._idleCheckId = 0;
    }
    if (this._stateTimeoutId) {
      GLib.source_remove(this._stateTimeoutId);
      this._stateTimeoutId = 0;
    }

    this._overviewWasShown = false;
    this._overviewHiding = false;
    // Only animate up if the dock was actually hidden
    this._dockWasHiddenOnOverviewEnter =
      this._dockBox &&
      (this._dockBox.translation_y > 0 || this._dockBox.opacity < 255);
    this._revealed = false;
  }

  _onOverviewHidden() {
    if (this._stateTimeoutId) {
      GLib.source_remove(this._stateTimeoutId);
      this._stateTimeoutId = 0;
    }
    this._overviewWasShown = false;
    this._overviewHiding = false;
    this._dockWasHiddenOnOverviewEnter = false;
    this._revealed = false;
    this._dockTargetHidden = this._shouldHideForFocusedWindow();
    this._onFocusWindowChangedDelayed();
  }

  _isHovered() {
    if (!this._dash || !this._dash.visible) return false;

    if (this._dash.hover) return true;

    try {
      const [x, y] = global.get_pointer();
      const [dashX, dashY] = this._dash.get_transformed_position();
      const [dashW, dashH] = this._dash.get_transformed_size();
      return (
        x >= dashX && x <= dashX + dashW && y >= dashY && y <= dashY + dashH
      );
    } catch {
      return false;
    }
  }

  _onPressureTrigger() {
    if (Main.overview.visible || Main.overview._animationInProgress) return;

    if (!this._shouldHideForFocusedWindow()) return;

    this._revealed = true;

    if (this._hideTimeoutId) {
      GLib.source_remove(this._hideTimeoutId);
      this._hideTimeoutId = 0;
    }

    if (this._revealTimeoutId) {
      GLib.source_remove(this._revealTimeoutId);
      this._revealTimeoutId = 0;
    }

    if (this._stateTimeoutId) {
      GLib.source_remove(this._stateTimeoutId);
      this._stateTimeoutId = 0;
    }

    this._dockTargetHidden = false;
    this._showDock();

    if (!this._isHovered()) {
      this._revealTimeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        800,
        () => {
          this._revealTimeoutId = 0;
          if (!this._isHovered() && !this._menuOpen) {
            this._revealed = false;
            this._updateVisibility();
          }
          return GLib.SOURCE_REMOVE;
        },
      );
    }
  }

  _onHoverChanged() {
    if (this._isHovered()) {
      if (this._hideTimeoutId) {
        GLib.source_remove(this._hideTimeoutId);
        this._hideTimeoutId = 0;
      }
      if (this._revealTimeoutId) {
        GLib.source_remove(this._revealTimeoutId);
        this._revealTimeoutId = 0;
      }
    } else {
      if (
        this._shouldHideForFocusedWindow() &&
        !Main.overview.visible &&
        !this._menuOpen
      )
        this._queueHide();
    }
  }

  _queueHide() {
    if (this._revealTimeoutId) {
      GLib.source_remove(this._revealTimeoutId);
      this._revealTimeoutId = 0;
    }
    if (this._hideTimeoutId) GLib.source_remove(this._hideTimeoutId);

    if (this._stateTimeoutId) {
      GLib.source_remove(this._stateTimeoutId);
      this._stateTimeoutId = 0;
    }

    this._hideTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
      this._hideTimeoutId = 0;
      if (
        this._shouldHideForFocusedWindow() &&
        !this._isHovered() &&
        !this._menuOpen &&
        !Main.overview.visible
      ) {
        this._revealed = false;
        this._dockTargetHidden = true;
        this._hideDock();
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  _updateVisibility(immediate = false) {
    if (Main.overview.visible || Main.overview._animationInProgress) return;

    const shouldHide = this._shouldHideForFocusedWindow();

    // If dock was revealed via pressure or is hovered/menuOpen:
    if (shouldHide && (this._revealed || this._isHovered() || this._menuOpen))
      return;

    if (this._stateTimeoutId) {
      GLib.source_remove(this._stateTimeoutId);
      this._stateTimeoutId = 0;
    }

    if (this._dockTargetHidden === shouldHide && !this._revealed) return;

    if (immediate) {
      this._dockTargetHidden = shouldHide;
      if (shouldHide) this._hideDock();
      else this._showDock();
      return;
    }

    // Debounce before changing state
    this._stateTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
      this._stateTimeoutId = 0;

      if (Main.overview.visible || Main.overview._animationInProgress)
        return GLib.SOURCE_REMOVE;

      const targetHide = this._shouldHideForFocusedWindow();
      this._dockTargetHidden = targetHide;

      if (targetHide) {
        if (!this._revealed && !this._isHovered() && !this._menuOpen)
          this._hideDock();
      } else {
        this._revealed = false;
        this._showDock();
      }

      return GLib.SOURCE_REMOVE;
    });
  }

  _showDock() {
    if (
      !this._dockBox ||
      Main.overview.visible ||
      Main.overview._animationInProgress
    )
      return;

    this._dockBox.remove_all_transitions();
    this._dockBox.ease({
      translation_y: 0,
      opacity: 255,
      duration: 250,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  _hideDock() {
    if (
      !this._dockBox ||
      Main.overview.visible ||
      Main.overview._animationInProgress
    )
      return;

    const hideY = this._dockBox.height > 0 ? this._dockBox.height : 80;

    this._dockBox.remove_all_transitions();
    this._dockBox.ease({
      translation_y: hideY,
      opacity: 0,
      duration: 250,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
    });
  }

  disable() {
    Main.layoutManager.disconnectObject(this);
    global.display.disconnectObject(this);
    global.window_manager.disconnectObject(this);
    global.workspace_manager.disconnectObject(this);
    Main.overview.disconnectObject(this);

    const controls = Main.overview._overview?._controls;
    if (controls?._stateAdjustment)
      controls._stateAdjustment.disconnectObject(this);

    if (this._focusWindow) {
      this._focusWindow.disconnectObject(this);
      this._focusWindow = null;
    }

    if (this._hideTimeoutId) {
      GLib.source_remove(this._hideTimeoutId);
      this._hideTimeoutId = 0;
    }

    if (this._revealTimeoutId) {
      GLib.source_remove(this._revealTimeoutId);
      this._revealTimeoutId = 0;
    }

    if (this._idleCheckId) {
      GLib.source_remove(this._idleCheckId);
      this._idleCheckId = 0;
    }

    if (this._stateTimeoutId) {
      GLib.source_remove(this._stateTimeoutId);
      this._stateTimeoutId = 0;
    }

    this._dockTargetHidden = null;
    this._overviewWasShown = false;
    this._overviewHiding = false;

    this._destroyBarrier();

    if (this._dash) {
      this._dash.disconnectObject(this);

      if (this._showAppsId) {
        this._dash.showAppsButton.disconnect(this._showAppsId);
        this._showAppsId = null;
      }

      if (this._origItemMenuStateChanged) {
        this._dash._itemMenuStateChanged = this._origItemMenuStateChanged;
        this._origItemMenuStateChanged = null;
      }
    }

    // Restore layout manager's dash reference and remove dummy actor
    if (controls && this._dummyDash) {
      if (this._origLayoutDash) {
        controls.layout_manager._dash = this._origLayoutDash;
        this._origLayoutDash = null;
      }
      if (this._dummyDash.get_parent() === controls)
        controls.remove_child(this._dummyDash);
      this._dummyDash.destroy();
      this._dummyDash = null;
    }

    // Restore real dash back to ControlsManager
    if (this._dash) {
      if (this._dash.get_parent() === this._dockBox)
        this._dockBox.remove_child(this._dash);
      if (this._origParent) this._origParent.add_child(this._dash);
      this._dash = null;
      this._origParent = null;
    }

    // Remove dock box from Chrome
    if (this._dockBox) {
      Main.layoutManager.removeChrome(this._dockBox);
      this._dockBox.destroy();
      this._dockBox = null;
    }
  }
}
