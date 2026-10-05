# Native Dock

> What if GNOME Shell had an on-screen dock, designed as a first-party upstream feature?

**Native Dock** is an ultra-minimal GNOME Shell extension that brings the native GNOME Shell Dash onto your desktop as a persistent dock.

Instead of reconstructing a dock from scratch or bundling third-party widget stacks and heavy preference panels, Native Dock repurposes the exact upstream `Main.overview.dash` component and integrates it seamlessly with GNOME's window manager and overview.

---

## Features

- **100% Native Dash**: Uses the actual GNOME Shell Dash component—your pinned apps, running indicators, and "Show Applications" button behave identically to vanilla GNOME.
- **Smart Auto-Hide**:
  - **Always Visible**: Visible on your desktop and beneath floating/unmaximized windows.
  - **Hides on Maximize & Tile**: Cleanly hides when the focused window is maximized, tiled, or fullscreen.
  - **Modal Dialog Awareness**: Automatically hides when modal dialogs appear so action buttons (OK, Cancel, Save) are never blocked.
- **Edge Pressure Reveal**: Summon the dock while working in a maximized window by pushing your cursor against the bottom edge of the screen, powered by GNOME's native `Layout.PressureBarrier`.
- **Overview & Gesture Lockstep**:
  - Synchronizes 1:1 with overview transitions and 3-finger touchpad gestures.
  - Pre-emptively stays visible when exiting the overview into a normal window (no dipping down or bouncing back up).
- **Calm, Settled Transitions**: Features an intentional ~400ms settling delay when maximizing or un-maximizing windows for a smooth, distraction-free aesthetic.
- **Zero Configuration**: No complex settings menus or bloated options. It just works out of the box with sane defaults.

---

## Installation

### Manual Installation

1. Clone or copy the repository into your GNOME Shell extensions directory:
   ```bash
   git clone https://github.com/DEM0NAssissan7/native-dock.git ~/.local/share/gnome-shell/extensions/native-dock@mawi.ink
   ```

2. Log out and log back in (required on Wayland so GNOME Shell discovers the new extension).

3. Enable the extension:
   ```bash
   gnome-extensions enable native-dock@mawi.ink
   ```

---

## Requirements

- **GNOME Shell**: 45+ (tested and optimized for GNOME 51 on Wayland)

---

## License

GPL-3.0-or-later
