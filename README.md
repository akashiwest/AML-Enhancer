## 为Windows端网页版apple music提供歌词翻译，数据来源为网易云平台。


### 功能：
在网页版Apple Music中可以获取原歌词与翻译歌词，根据播放时间自动选择合适的歌词，显示在页面中一个可以随处拖动的高斯模糊容器中。

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
