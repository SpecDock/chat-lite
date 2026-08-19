# chat-lite Android

这是 `chat-lite` 的原生 Java WebView Android 壳，包名为 `com.specdock.chatlite`。

## 工程与构建

- JDK 17
- Gradle wrapper 8.7
- Android Gradle Plugin 8.6.1
- `compileSdk 35` / `targetSdk 35`
- `minSdk 29`
- Groovy Gradle，单模块 `app`
- 仅使用 Android 平台 API，不包含第三方依赖

在本目录执行：

```powershell
.\gradlew.bat :app:assembleDebug
```

APK 产物：

```text
app/build/outputs/apk/debug/app-debug.apk
```

## 应用行为

- WebView 固定加载 `https://chat.zzxandyl.cn`，不提供地址输入。
- 仅允许该 HTTPS 域名作为主框架导航，外部站点跳转会被拦截；明文流量和混合内容均禁止。
- 显式开启 JavaScript、DOM Storage 与 Cookie，支持 WebView 网页请求的系统文件选择器，可选择图片和普通文件；只有网页控件请求 `multiple` 时才允许多选。
- 使用沉浸式全屏隐藏状态栏与导航栏，并根据刘海和系统手势安全区调整根视图内边距。
- 返回键优先执行 WebView 历史导航；没有历史记录时退出应用。
- Debug 构建开启 WebView 调试，非 Debug 构建关闭。
- 应用图标为 Android vector drawable，使用当前前端的暖白、炭黑、珊瑚色和蓝绿色配色，不使用位图或 emoji。
