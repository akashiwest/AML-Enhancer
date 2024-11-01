![示例图片]([https://example.com/image.jpg](https://mono.imakashi.eu.org/opensource/github-amlenhancer1.webp])
## 为Windows端网页版apple music提供歌词翻译，数据来源为网易云平台。
在 [greasyfork](https://greasyfork.org/zh-CN/scripts/493948-apple-music-%E6%AD%8C%E8%AF%8D%E5%A2%9E%E5%BC%BA) 安装

***

### 安装方法
1. 点击安装，然后打开music.apple.com，随便点击一首歌（不是纯音乐）播放；
2. 此时可能会跳出“一个用户脚本试图访问跨源资源”的窗口，请选择“总是允许”，
这是为了访问 music.163.com 网易云音乐的api，你可以看见页面上的提示信息，不存在恶意请求。

### 功能：
在网页版Apple Music中获取来自网易云音乐的歌词信息，根据播放时间自动显示原歌词与翻译歌词，显示在页面中一个可以随处拖动的优雅的高斯模糊容器中。

### 目前的问题：
1. 因网易云版权问题，某些歌版权网易云没有，因此也获取不到正确的歌词；（感谢志愿者上传了一些无版权歌曲的歌词，例如 NewJeans 和周杰伦）
2. Apple Music 会将一些日文歌歌名与歌手统统设置为罗马字，有找不到正确歌词的可能；（给我风哥整成 fujii kaze 了）
3. 当一首歌播完自动切歌后下一首歌的歌词会存在显示异常，需要手动点一下进度条方可正常显示
（自动播放下一曲后Apple Music的播放时间不归零就很奇怪，只能等我后面再看看或者哪位大佬来修改下）

### 免责协议：
本脚本仅用于个人学习研究，禁止用于商业用途。歌词数据来源为网易云音乐，版权所有。

### 隐私协议：
**本插件不收集你的任何个人信息。**

遵循 GNU GPL 3.0 版权协议
&copy; 2024 Akashi & Netease Music
