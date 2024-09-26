// ==UserScript==
// @name       Apple Music 歌词增强
// @namespace  https://imakashi.eu.org/
// @version    1.04
// @description  为Windows端网页版apple music提供歌词翻译，数据来源为网易云平台
// @author     Akashi
// @match      https://beta.music.apple.com/*
// @grant      GM_xmlhttpRequest
// ==/UserScript==

(function() {
    'use strict';

    // 创建歌词显示区域
    function createLyricsDisplay() {
        // 设置歌词显示区域及样式
        const lyricsDiv = document.createElement('div');

        lyricsDiv.id = 'lyrics-display';
        lyricsDiv.style.position = 'fixed';
        lyricsDiv.style.right = '20px';
        lyricsDiv.style.top = '60px';
        lyricsDiv.style.width = '50vw';
        lyricsDiv.style.height = 'auto';
        lyricsDiv.style.minHeight = '60px';
        lyricsDiv.style.overflow = 'auto';
        lyricsDiv.style.borderRadius = '15px';
        lyricsDiv.style.backdropFilter = 'saturate(200%) blur(23px)';
        lyricsDiv.style.webkitBackdropFilter = 'saturate(200%) blur(23px)';
        lyricsDiv.style.background = 'rgba(250,250, 250, 0.72)';
        lyricsDiv.style.zIndex = '9999';
        lyricsDiv.style.resize = 'both';
        lyricsDiv.style.padding = '20px';
        lyricsDiv.style.paddingLeft = '30px';
        lyricsDiv.style.paddingRight = '30px';
        lyricsDiv.style.fontSize = '28px';
        lyricsDiv.style.color = '#565656';
        lyricsDiv.style.lineHeight = '1.4';
        lyricsDiv.style.msOverflowStyle = 'none';
        lyricsDiv.style.scrollbarWidth = 'none';
        lyricsDiv.style.WebkitScrollbar = 'none';
        lyricsDiv.style.textAlign = 'center';
        lyricsDiv.style.display = 'inline-block';
        lyricsDiv.style.boxShadow = '0 5px 30px rgba(0, 0, 0, 0.4)';
        lyricsDiv.style.fontWeight = 'bold';

        // 设置初始内容
        lyricsDiv.innerHTML = 'Apple Music 歌词增强 <small>V1.04</small>';
        document.body.appendChild(lyricsDiv);

        // 拖动功能
        let pos1 = 0,
            pos2 = 0,
            pos3 = 0,
            pos4 = 0;
        lyricsDiv.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            e = e || window.event;
            e.preventDefault();
            // 获取鼠标点击位置的初始坐标
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            // 鼠标移动时触发
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e = e || window.event;
            e.preventDefault();
            // 计算div的新位置
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            // 设置div的新位置
            lyricsDiv.style.top = (lyricsDiv.offsetTop - pos2) + "px";
            lyricsDiv.style.left = (lyricsDiv.offsetLeft - pos1) + "px";
        }

        function closeDragElement() {
            // 清除拖动事件
            document.onmouseup = null;
            document.onmousemove = null;
        }

        return lyricsDiv;
    }

    // 获取歌曲ID的函数
    function getSongId(lyricsDisplay) {
        // 从audio标签获取title
        const audioPlayer = document.getElementById('apple-music-player');
        if (!audioPlayer) {
            console.log('当前页面未找到音频播放器');
            return;
        }
        let title = audioPlayer.title;
        const secondDashIndex = title.indexOf('-', title.indexOf('-') + 1);
        if (secondDashIndex !== -1) {
            title = title.substring(0, secondDashIndex).trim();
        }
        lyricsDisplay.innerText = title;

        // 构造请求链接
        const apiUrl = 'https://music.163.com/api/search/pc?s=' + encodeURIComponent(title) + '&offset=0&limit=1&type=1';
        // 发送请求
        GM_xmlhttpRequest({
            method: "GET",
            url: apiUrl,
            responseType: "json",
            onload: function(response) {
                if (response.status === 200) {
                    const data = response.response;
                    if (data.result && data.result.songs && data.result.songs.length > 0) {
                        // 获取网易云平台歌曲ID
                        const firstSongId = data.result.songs[0].id;
                        getLyrics(firstSongId, lyricsDisplay);
                        console.log(title);
                        console.log('ID - '+firstSongId);
                    } else {
                        lyricsDisplay.innerText = "未找到歌曲";
                    }
                } else {
                    lyricsDisplay.innerText = "请求失败";
                }
            },
            onerror: function(err) {
                console.error("未知错误");
            }
        });
    }

    // 获取歌词
    function getLyrics(songId, lyricsDisplay) {
        // 构造请求链接
        const apiUrl = 'https://music.163.com/api/song/lyric?lv=1&kv=1&tv=-1&id=' + songId;
        lyricsDisplay.innerText = '... 加载中 ...';
        // 发送请求
        GM_xmlhttpRequest({
            method: "GET",
            url: apiUrl,
            responseType: "json",
            onload: function(response) {
                if (response.status === 200) {
                    const data = response.response;
                    const lyricsTransLines = data.tlyric.lyric;
                    const lyricsLines = data.lrc.lyric;

                    // 创建歌词对象数组
                    const lyricss = parseLyrics(lyricsLines);
                    // 创建翻译歌词对象数组
                    const tlyricss = parseLyrics(lyricsTransLines);

                    // 设置歌曲ID备用
                    const audioPlayer = document.getElementById('apple-music-player');
                    audioPlayer.dataset.songId = songId;

                    // 监听音乐切换事件
                    document.addEventListener('timeupdate', function(event) {
                        const audioPlayer = event.target;
                        if (audioPlayer.id === 'apple-music-player') {
                            const currentTime = audioPlayer.currentTime;
                            console.log(currentTime);
                            let currentLyric = findCurrentLyric(currentTime, lyricss);
                            let currentTLyric = findCurrentLyric(currentTime, tlyricss);
                            updateLyricsDisplay(currentLyric, currentTLyric, lyricsDisplay);
                        }
                    }, true);

                } else {
                    lyricsDisplay.innerText = '... 歌词获取失败 ...';
                }
            },
            onerror: function(err) {
                console.error(err);
            }
        });
    }

    // 解析歌词字符串，返回歌词对象数组
    function parseLyrics(lyricsText) {
        return lyricsText.split('\n').filter(line => line.trim() !== '').map(line => {
            const matches = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/);
            if (matches) {
                const minutes = parseInt(matches[1]);
                const seconds = parseInt(matches[2]);
                const milliseconds = parseInt(matches[3]) || 0;
                const text = matches[4].trim();
                // 计算总秒数，包括后三位小数部分
                const totalSeconds = minutes * 60 + seconds + milliseconds / 1000;
                return {
                    startTime: totalSeconds,
                    text: text
                };
            }
        }).filter(Boolean);
    }

    // 查找当前时间所在的歌词
    function findCurrentLyric(currentTime, lyrics) {
        for (let i = 0; i < lyrics.length; i++) {
            if (currentTime >= lyrics[i].startTime && (i === lyrics.length - 1 || currentTime < lyrics[i + 1].startTime)) {
                return lyrics[i];
            }
        }
        return null;
    }

    // 更新歌词显示区域
    function updateLyricsDisplay(currentLyric, currentTLyric, lyricsDisplay) {
        lyricsDisplay.innerText = '... 加载中 ...';
        if (currentLyric) {
            lyricsDisplay.innerText = '';
            const lyricHTML = `<span>${currentLyric.text}</span><br><span style="opacity:.8;font-size:23px;">${currentTLyric ? currentTLyric.text : ''}</span>`;
            lyricsDisplay.innerHTML = lyricHTML;
        } else {
            lyricsDisplay.innerText = '... ...';
        }
    }
    const lyricsDisplay = createLyricsDisplay();

    // 检测切歌
    setInterval(function() {
        const audioPlayer = document.getElementById('apple-music-player');
        let title = audioPlayer.title;
        if (title) {
            const secondDashIndex = title.indexOf('-', title.indexOf('-') + 1);
            if (audioPlayer) {
                if (secondDashIndex !== -1) {
                    title = title.substring(0, secondDashIndex).trim();
                }
                // 重新获取歌曲ID
                if (title !== audioPlayer.dataset.lastTitle) {
                    audioPlayer.dataset.lastTitle = title;
                    lyricsDisplay.innerText = '... 加载中 ...';
                    /*audioPlayer.pause();
                    audioPlayer.currentTime = 0;
                    audioPlayer.play();*/
                    getSongId(lyricsDisplay);
                }
            }
        } // if title - end
    }, 1000);
})();
