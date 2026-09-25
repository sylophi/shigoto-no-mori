// Whether this client also serves a machine of its own. The desktop
// app does: its window runs on a device that hosts projects, so the
// Settings page has a section for that device and for the launch tools
// detected on it. The web client is a hostless controller (PRODUCT.md):
// every device it shows is a peer, and it has no local section to
// offer. Read once off the bridge like localDeviceId, so the surfaces
// that branch on it (settingsNav, SettingsForm, SettingsSidebarNav)
// agree without threading a prop.
export const hasLocalHost: boolean = window.api.isElectron;
