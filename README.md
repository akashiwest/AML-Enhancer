## 为Windows端网页版 Apple Music 提供歌词翻译的油猴脚本，数据来源为网易云平台。
在 [greasyfork](https://greasyfork.org/zh-CN/scripts/493948-apple-music-%E6%AD%8C%E8%AF%8D%E5%A2%9E%E5%BC%BA) 安装

### 功能：
在网页版Apple Music中可以获取原歌词与翻译歌词，根据播放时间自动选择合适的歌词，显示在页面中一个可以随处拖动的高斯模糊容器中。

### 安装方法
1. 点击安装，然后打开music.apple.com，随便点击一首歌（不是纯音乐）播放；
2. 此时可能会跳出“一个用户脚本试图访问跨源资源”的窗口，请选择“总是允许”，
这是为了访问 music.163.com 网易云音乐的api，你可以看见页面上的提示信息，不存在恶意请求。

### 目前的问题：
1. 因网易云版权问题，例如周杰伦和New Jeans的某些歌网易云没有，因此也获取不到正确的歌词；
2. 因网易云api问题，某些歌曲不返回歌词，个人测试有：张雨生 - 河；
3. Apple Music 国区会将一些日文歌歌名与歌手统统设置为罗马字，有找不到正确歌词的可能；
4. 当一首歌播完自动切歌后下一首歌的歌词会存在显示异常，需要手动归零进度条方可正常显示
（Apple Music的播放时间不归零就很奇怪，只能等我后面再看看或者哪位大佬来修改下）

### 免责协议：
本脚本仅用于个人学习研究，禁止用于商业用途。歌词数据来源为网易云音乐，版权所有。

### 隐私协议：
**本插件不收集你的任何个人信息。**

遵循 GNU GPL 3.0 版权协议
&copy; 2024 Akashi & Netease Music
