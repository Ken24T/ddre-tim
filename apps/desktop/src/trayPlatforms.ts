import cinnamonIcon from "./tray-cinnamon.svg";
import gnomeIcon from "./tray-gnome.svg";
import windowsIcon from "./tray-windows.svg";

export type DesktopPlatformId = "cinnamon" | "gnome" | "windows";

export interface TrayPlatformDefinition {
  id: DesktopPlatformId;
  label: string;
  iconAsset: string;
  status: "current" | "queued";
  helper: string;
  trayNotes: string;
}

export const trayPlatforms: TrayPlatformDefinition[] = [
  {
    id: "cinnamon",
    label: "Linux Cinnamon",
    iconAsset: cinnamonIcon,
    status: "current",
    helper: "Current implementation slice",
    trayNotes: "Menu-first tray flow, stable indicator area, and no reliance on click-only tray semantics."
  },
  {
    id: "gnome",
    label: "GNOME",
    iconAsset: gnomeIcon,
    status: "queued",
    helper: "Compatibility slice",
    trayNotes: "Needs explicit extension and launcher fallback validation across X11 and Wayland."
  },
  {
    id: "windows",
    label: "Windows 11",
    iconAsset: windowsIcon,
    status: "queued",
    helper: "Compatibility slice",
    trayNotes: "Requires packaged notification-area icon, autostart, and smoke-tested context menu behaviour."
  }
];

export const activeTrayPlatform = trayPlatforms[0];