// ==UserScript==
// @name       Apple Music 歌词增强
// @namespace  https://github.com/akashiwest/AML-Enhancer
// @version    1.050
// @description  为 Windows 端网页版 Apple Music 提供歌词翻译，数据来源为网易云音乐
// @author     Akashi
// @license     GNU GPL 3.0
// @match      https://*.music.apple.com/*
// @grant      GM_xmlhttpRequest
// ==/UserScript==
 
(function() {
    'use strict';
 
    function createLyricsDisplay() {
        const lyricsDiv = document.createElement('div');
        lyricsDiv.id = 'lyrics-display';
        Object.assign(lyricsDiv.style, {
            position: 'fixed',
            right: '20px',
            top: '60px',
            width: '50vw',
            minHeight: '60px',
            overflow: 'auto',
            borderRadius: '15px',
            backdropFilter: 'saturate(200%) blur(23px)',
            background: 'rgba(250,250, 250, 0.72)',
            zIndex: '9999',
            padding: '20px 30px',
            fontSize: '28px',
            color: '#565656',
            lineHeight: '1.4',
            textAlign: 'center',
            display: 'inline-block',
            boxShadow: '0 5px 30px rgba(0, 0, 0, 0.4)',
            fontWeight: 'bold',
            msOverflowStyle: 'none',
            scrollbarWidth: 'none',
            WebkitScrollbar: 'none',
        });
 
        lyricsDiv.innerHTML = 'Apple Music 歌词增强 <small>1.05</small>';
        document.body.appendChild(lyricsDiv);
        lyricsDiv.onmousedown = dragMouseDown;
 
        // 拖动功能
        let pos3 = 0, pos4 = 0;
 
        function dragMouseDown(e) {
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }
 
        function elementDrag(e) {
            e.preventDefault();
            const pos1 = pos3 - e.clientX;
            const pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            lyricsDiv.style.top = `${lyricsDiv.offsetTop - pos2}px`;
            lyricsDiv.style.left = `${lyricsDiv.offsetLeft - pos1}px`;
        }
 
        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
 
        return lyricsDiv;
    }
 
    // 获取歌曲ID
    function getSongId(lyricsDisplay) {
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
 
        const apiUrl = `https://music.163.com/api/search/pc?s=${title}&offset=0&limit=1&type=1`;
        GM_xmlhttpRequest({
            method: "GET",
            url: apiUrl,
            responseType: "json",
            onload: function(response) {
                if (response.status === 200) {
                    const data = response.response;
                    if (data.result && data.result.songs && data.result.songs.length > 0) {
                        const firstSongId = data.result.songs[0].id;
                        getLyrics(firstSongId, lyricsDisplay);
                        console.log(apiUrl, 'ID - ' + firstSongId);
                    } else {
                        lyricsDisplay.innerText = "未找到歌曲";
                    }
                } else {
                    lyricsDisplay.innerText = "请求失败";
                }
            },
            onerror: function() {
                console.error("未知错误");
            }
        });
    }
 
    // 获取歌词
    function getLyrics(songId, lyricsDisplay) {
        const apiUrl = `https://music.163.com/api/song/lyric?lv=1&kv=1&tv=-1&id=${songId}`;
        lyricsDisplay.innerText = '... 加载中 ...';
        GM_xmlhttpRequest({
            method: "GET",
            url: apiUrl,
            responseType: "json",
            onload: function(response) {
                if (response.status === 200) {
                    const data = response.response;
                    const lyricsTransLines = data.tlyric.lyric;
                    const lyricsLines = data.lrc.lyric;
 
                    const lyricss = parseLyrics(lyricsLines);
                    const tlyricss = parseLyrics(lyricsTransLines);
 
                    const audioPlayer = document.getElementById('apple-music-player');
                    audioPlayer.dataset.songId = songId;
 
                    document.addEventListener('timeupdate', function(event) {
                        const audioPlayer = event.target;
                        if (audioPlayer.id === 'apple-music-player') {
                            const currentTime = audioPlayer.currentTime;
                            const currentLyric = findCurrentLyric(currentTime, lyricss);
                            const currentTLyric = findCurrentLyric(currentTime, tlyricss);
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
 
    // 解析歌词
   function parseLyrics(lyricsText) {
    return lyricsText.split('\n').filter(line => line.trim() !== '').map(line => {
        const matches = line.match(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/);
        if (matches) {
            const minutes = parseInt(matches[1]);
            const seconds = parseInt(matches[2]);
            let milliseconds = matches[3] ? parseInt(matches[3]) : 0;
 
            // 补充毫秒位为三位数
            if (milliseconds < 100 && milliseconds >= 10) {
                milliseconds *= 10;
            }
 
            const text = matches[4].trim();
            const totalSeconds = minutes * 60 + seconds + milliseconds / 1000;
            return { startTime: totalSeconds, text: text };
        }
    }).filter(Boolean);
}
 
    // 查找当前歌词
    function findCurrentLyric(currentTime, lyrics) {
        return lyrics.find((lyric, i) =>
            currentTime >= lyric.startTime &&
            (i === lyrics.length - 1 || currentTime < lyrics[i + 1].startTime)
        ) || null;
    }
 
    // 更新歌词
    function updateLyricsDisplay(currentLyric, currentTLyric, lyricsDisplay) {
        lyricsDisplay.innerText = '... 加载中 ...';
        if (currentLyric) {
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
        if (audioPlayer) {
            let title = audioPlayer.title;
            if (title) {
                const secondDashIndex = title.indexOf('-', title.indexOf('-') + 1);
                if (secondDashIndex !== -1) {
                    title = title.substring(0, secondDashIndex).trim();
                }
                if (title !== audioPlayer.dataset.lastTitle) {
                    audioPlayer.dataset.lastTitle = title;
                    lyricsDisplay.innerText = '... 加载中 ...';
                    getSongId(lyricsDisplay);
                }
            }
        }
    }, 1000);
})();
