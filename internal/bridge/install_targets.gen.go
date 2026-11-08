// Code generated from protocol/install-targets.json. DO NOT EDIT.
package bridge

const hostName = "com.browserbridge.browser_bridge"
const publishedExtensionID = "jjjkmmcdkpcgamlopogicbnnhdgebhie"
const nativeMaxBytes = 10000000

var browserRegistry = []browserDefinition{{key: "chrome", macDir: "Google/Chrome", windowsDir: "Google/Chrome/User Data", windowsManifestDir: "NativeMessagingHosts/chrome", linuxDir: "google-chrome", registry: "Google\\Chrome"}, {key: "edge", macDir: "Microsoft Edge", windowsDir: "Microsoft/Edge/User Data", windowsManifestDir: "NativeMessagingHosts/edge", linuxDir: "microsoft-edge", registry: "Microsoft\\Edge"}, {key: "brave", macDir: "BraveSoftware/Brave-Browser", windowsDir: "BraveSoftware/Brave-Browser/User Data", windowsManifestDir: "NativeMessagingHosts/brave", linuxDir: "BraveSoftware/Brave-Browser", registry: "BraveSoftware\\Brave-Browser"}, {key: "chromium", macDir: "Chromium", windowsDir: "Chromium/User Data", windowsManifestDir: "NativeMessagingHosts/chromium", linuxDir: "chromium", registry: "Chromium"}, {key: "arc", macDir: "Arc/User Data", windowsDir: "Arc/User Data", windowsManifestDir: "NativeMessagingHosts/arc", linuxDir: "Arc/User Data", registry: "Chromium"}}
var nativePlatformRegistry = []nativePlatformDefinition{{key: "darwin-arm64", goos: "darwin", goarch: "arm64", asset: "bbx-darwin-arm64"}, {key: "darwin-x64", goos: "darwin", goarch: "amd64", asset: "bbx-darwin-x64"}, {key: "linux-arm64", goos: "linux", goarch: "arm64", asset: "bbx-linux-arm64"}, {key: "linux-x64", goos: "linux", goarch: "amd64", asset: "bbx-linux-x64"}, {key: "win32-arm64", goos: "windows", goarch: "arm64", asset: "bbx-windows-arm64.exe"}, {key: "win32-x64", goos: "windows", goarch: "amd64", asset: "bbx-windows-x64.exe"}}
