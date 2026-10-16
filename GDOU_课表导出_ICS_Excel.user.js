// ==UserScript==
// @name        广东海洋大学-正方教务系统课程表导出(ICS+Excel+课刻)
// @namespace   http://tampermonkey.net/
// @version      1.3.2
// @description  适配广东海洋大学新版正方教务系统：课表页面一键导出 ICS 日历文件、普通 Excel(周视图+课程明细)、或「课刻 desktop-course-widget」专用 xlsx(单工作表网格 + 右侧作息时间表，导入课刻自动应用作息)。v1.3.2 更新：①加回作息时间表（右侧 I 列，节次/开始/结束，课刻导入自动应用）；②作息时间改为海大现行作息（第1节 08:10-08:55，第2节 09:00-09:45，第3节 10:15-11:00，第4节 11:05-11:50，第5节 14:30-15:15，第6节 15:20-16:05，第7节 16:30-17:15，第8节 17:20-18:05，第9节 19:30-20:15，第10节 20:25-21:10）；③默认第一周星期一=2026-08-31（可改）；④parseTable 三档兜底，兼容新版无 id 表格；⑤节次正则支持 (3~4节) 的 ~ 分隔；⑥地点/教师提取适配"考查/考试"行。基线 v1.2.0 已含：不硬编码 fonts[1]；周次全局正则（兼容◎图标、单周"第N周"）；解析失败留空并告警。
// @author      feldan / 31415926535x / modified by doubao
// @compatible  chrome
// @compatible  firefox
// @license     MIT
// @include     *://jw.gdou.edu.cn/*
// @include     *://wfw.gdou.edu.cn/*
// @run-at      document-start
// ==/UserScript==

// 广东海洋大学教务系统页面路径（如其他学校可按需修改）
var ClassScheduleToICSURL = "kbcx/xskbcx_cxXskbcxIndex.html";   // 学生课表查询页面
var ExamScheduleToICSURL  = "kwgl/kscx_cxXsksxxIndex.html";     // 考试信息查询页面(本版本未启用)
var StudentEvalutionURL   = "xspjgl/xspj_cxXspjIndex.html";     // 学生评教页面(本版本未启用)

var setTimeout_ = 4000;

(function (){
    'use strict';
    console.log("Script running.....");
    unsafeWindow.addEventListener("load", main);
})();

function main(){
    var windowURL = window.location.href;
    if(windowURL.indexOf(ClassScheduleToICSURL) != -1){
        ClassScheduleToICS();
    }
    else if(windowURL.indexOf(ExamScheduleToICSURL) != -1){
        console.log("考试信息页面：本版本仅支持课表导出(ICS/Excel)，如需导出考试信息请在原仓库启用 ExamScheduleToICS");
    }
    else if(windowURL.indexOf(StudentEvalutionURL) != -1){
        console.log("学生评教页面：本版本未启用学生评教辅助功能");
    }
}

function ClassScheduleToICS(){
    console.log("ClassScheduleToICS");
    // 在课表上方创建操作按钮
    pageFullyLoaded();

    function pageFullyLoaded(){
        console.log("Loading ZhengFang...");
        // 找到课表工具栏；若页面结构不同则自建一个工具栏
        let div = document.getElementsByClassName("btn-toolbar pull-right")[0]
                  || document.getElementsByClassName("btn-toolbar")[0];
        if(!div){
            div = document.createElement("div");
            div.className = "btn-toolbar pull-right";
            let anchor = document.querySelector(".panel-body, .content, #content") || document.body;
            anchor.appendChild(div);
        }

        // 按钮1：生成课表(ICS)
        let btn = document.createElement("button");
        btn.className = "btn btn-default";
        btn.id = "exportbtn";
        let sp = document.createElement("span");
        sp.innerText = "生成课表";
        sp.className = "bigger-120 glyphicon glyphicon-file";
        btn.append(sp);

        // 按钮2：导出Excel
        let xbtn = document.createElement("button");
        xbtn.className = "btn btn-default";
        xbtn.id = "exportexcelbtn";
        sp = document.createElement("span");
        sp.innerText = "导出Excel";
        sp.className = "bigger-120 glyphicon glyphicon-download-alt";
        xbtn.append(sp);

        // 按钮3：导出课刻(desktop-course-widget)专用xlsx
        let wbtn = document.createElement("button");
        wbtn.className = "btn btn-default";
        wbtn.id = "exportwidgetbtn";
        sp = document.createElement("span");
        sp.innerText = "导出课刻";
        sp.className = "bigger-120 glyphicon glyphicon-calendar";
        wbtn.append(sp);

        // 日期选择（本学期第一个星期一）
        let dwnbtn = document.createElement("button");
        dwnbtn.className = "btn btn-default";
        sp = document.createElement("span");
        sp.innerText = "选择本学期第一个星期一:     ";
        sp.className = "bigger-120 glyphicon glyphicon-time";
        dwnbtn.appendChild(sp);
        let StartDate = document.createElement("input");
        StartDate.type = "date";
        StartDate.value = DEFAULT_FIRST_MONDAY;
        dwnbtn.appendChild(StartDate);

        div.appendChild(btn);
        div.appendChild(xbtn);
        div.appendChild(wbtn);
        div.appendChild(dwnbtn);

        btn.onclick = function(){
            startDate = StartDate.value;
            generateCalendar(parseCourses(parseTable()));
            alert("ics文件已经生成，请导入到您所使用的日历文件；（Google Calendar需要自行设置课程的颜色。。。）\n如发现获取到的数据有误，请尽量使用F12进入开发者模式并附上截屏。");
        };
        xbtn.onclick = function(){
            startDate = StartDate.value;
            exportToExcel(parseCourses(parseTable()));
        };
        wbtn.onclick = function(){
            startDate = StartDate.value;
            exportToWidget(parseCourses(parseTable()));
        };
    }

    // 本学期设定的开始日期
    var startDate;

    // 默认第一周星期一（2026-2027学年第1学期开学第一周；可自行修改）
    var DEFAULT_FIRST_MONDAY = "2026-08-31";

    // 全局变量Week的双引射
    var Week;
    (function (Week) {
        Week[Week["Monday"] = 1] = "Monday";
        Week[Week["TuesDay"] = 2] = "TuesDay";
        Week[Week["Wednesday"] = 3] = "Wednesday";
        Week[Week["ThursDay"] = 4] = "ThursDay";
        Week[Week["Friday"] = 5] = "Friday";
        Week[Week["Saturday"] = 6] = "Saturday";
        Week[Week["Sunday"] = 7] = "Sunday";
    })(Week || (Week = {}));

    // 从页面中获取课程的 div, 返回对应的星期以及div数组
    // v1.3.2：三档兜底——①旧版 kbgrid_table_0 + td带id；②任意含"星期X"表头的表格；
    // ③新版界面 td 无 id 时，按表头列映射星期 + 行首节次解析（不再依赖 td id）
    function parseTable(){
        let week = new Array();
        let divs = new Array();

        // 1) 候选表格：优先旧版 id，其次任意含"星期X"表头的表格
        let table = document.getElementById("kbgrid_table_0");
        if(!table){
            let tables = Array.from(document.querySelectorAll("table"));
            for(let t of tables){
                if(/星期[一二三四五六日]/.test(t.textContent || "")){
                    table = t;
                    break;
                }
            }
        }
        if(!table){
            console.warn("%c [parseTable] 未找到课表表格（kbgrid_table_0 或含'星期X'表头的 table）", "color: orange");
            alert("未找到课表表格，请确认当前页面为「学生课表查询」页面并已加载课表。");
            return {week: [], divs: []};
        }

        // 2) 方式A：td 带 id（旧版），星期 = id 首字符
        let tds = table.querySelectorAll("td");
        let idTds = 0;
        tds.forEach(element => {
            if(element.hasAttribute("id")){
                idTds++;
                if(element.hasChildNodes()){
                    let div = Array.from(element.getElementsByTagName("div"));
                    divs = divs.concat(div);
                    let wk = Week[element.getAttribute("id")[0]];
                    for(let i = 0; i < div.length; ++i){
                        week.push(wk);
                    }
                }
            }
        });

        // 3) 方式B：td 无 id（新版）→ 表头列映射 + 行首节次
        if(week.length === 0){
            let rows = Array.from(table.querySelectorAll("tr"));
            // 找表头行（含"星期一"）
            let headerRow = null;
            for(let r of rows){
                let t = (r.textContent || "").trim();
                if(t.indexOf("星期一") !== -1 || /星期[一二三四五六日]/.test(t)){
                    headerRow = r;
                    break;
                }
            }
            if(headerRow){
                let cells = Array.from(headerRow.querySelectorAll("th, td"));
                let colWeek = {};
                cells.forEach((c, idx) => {
                    let t = (c.textContent || "").trim();
                    for(let w = 1; w <= 7; w++){
                        if(t === "星期" + "一二三四五六日"[w - 1]) colWeek[idx] = w;
                    }
                });
                rows.forEach(row => {
                    if(row === headerRow) return;
                    let c2 = Array.from(row.querySelectorAll("td, th"));
                    if(!c2.length) return;
                    // 行首单元格为节次（数字 或 "第N节"；时间段行/空行跳过）
                    let first = (c2[0].textContent || "").trim();
                    let secMatch = first.match(/第?\s*(\d{1,2})\s*节?/);
                    if(!secMatch) return;
                    let section = parseInt(secMatch[1]);
                    if(!(section >= 1 && section <= 24)) return;
                    for(let w = 1; w <= 7; w++){
                        let c = c2[colWeek[w]];
                        if(!c) continue;
                        let dv = Array.from(c.getElementsByTagName("div"));
                        if(dv.length){
                            dv.forEach(d => { divs.push(d); week.push(w); });
                        }
                        else if((c.textContent || "").trim() !== ""){
                            divs.push(c);
                            week.push(w);
                        }
                    }
                });
            }
        }

        // 诊断信息：仍为空时输出页面结构样本，便于定位新版界面结构
        if(week.length === 0){
            console.warn("%c [parseTable] 未解析到课程（表格: " + (table.id || table.className || "无id/class") + "，td总数: " + tds.length + "，带id的td: " + idTds + "）。若为新版界面，请把控制台输出的表格片段发给我适配。", "color: orange");
            console.log("[parseTable 诊断] 前2个tr结构样本：");
            (table.querySelectorAll("tr") || []).slice(0, 2).forEach(r => {
                if(r && r.outerHTML) console.log(r.outerHTML.slice(0, 300));
            });
        }
        return {week: week, divs: divs};
    }

    // 全局变量 课程信息类
    class Course{
        constructor(course){
            if(course){
                this.name = course.name;                // 课程名称
                this.week = course.week;                // 该课程具体是星期几
                this.info = course.info;                // 该课程的一个这个时段的信息
                this.startTime = course.startTime;      // 该课程的开始上课节次
                this.endTime = course.endTime;
                this.weekSegments = course.weekSegments;  // 周次段: [{start,end,parity}]
                this.startWeek = course.startWeek;      // 该课程的持续上课的起始周，为一个数组
                this.endWeek = course.endWeek;
                this.isSingleOrDouble = course.isSingleOrDouble;  // 是否间隔上课，间隔为2
                this.location = course.location;        // 该课程的上课地点
                this.teacher = course.teacher;          // 该课程的任课老师
            }
        }
    }

    // 获取课程名：多种方式尝试，并支持同格其他课程div继承课程名(V9.0)
    function extractCourseName(div, depth){
        depth = depth || 0;
        if(depth > 1) return "";
        let name = "";
        let candidates = [];
        try{
            let spans = div.getElementsByTagName("span");
            if(spans.length){
                let fonts = spans[0].getElementsByTagName("font");
                if(fonts.length) candidates.push(fonts[0].innerText);
            }
        }catch(e){}
        try{
            let us = div.getElementsByTagName('u');
            if(us.length) candidates.push(us[0].innerText);
        }catch(e){}
        try{
            if(div.children.length) candidates.push(div.children[0].innerText);
        }catch(e){}
        try{
            if(div.innerText) candidates.push(div.innerText.split('\n\n')[0]);
        }catch(e){}
        for(let c of candidates){
            if(c && c.trim()){ name = c; break; }
        }
        // V9.0：多时段课同格继承课程名——从同一格子中的其他课程div继承
        if(!name){
            let td = div.closest ? div.closest('td') : null;
            if(td){
                let divs = td.querySelectorAll('div');
                for(let j = 0; j < divs.length; ++j){
                    if(divs[j] === div) continue;
                    let n = extractCourseName(divs[j], depth + 1);
                    if(n){ name = n; break; }
                }
            }
        }
        name = (name || "").replace(/^\s+/, '').replace(/\s+$/, '');
        name = name.replace(/☆/g, "").replace(/★/g, "").replace(/【调】/g, "").replace(/（调）/g, "");
        return name;
    }

    // 周次解析 v1.2.0：全局正则搜索，不依赖文本前缀格式
    // 在整段文本中直接找所有 "数字+周" 模式，避免被节次/地点/教师等干扰。
    // 兼容：◎(1-2节)1-5周,7-8周 / (1-2节)第3周 / 1-3周(单),7-13周(单) / (3~4节)2-16周（双）
    function parseWeekSegments(fullInfo){
        let res = [];
        if(!fullInfo) return res;
        let text = String(fullInfo);
        // 全局匹配周次段：第?数字[-数字]?周[(单|双)]?
        // 注意：节次是 (x-y节)，后面跟"节"不跟"周"，所以不会误匹配。
        let regex = /第?\s*\d+(?:\s*[-—~]\s*\d+)?\s*周\s*(?:[\(（]\s*([单双])\s*[\)）])?/g;
        let match;
        let seen = {};
        while((match = regex.exec(text)) !== null){
            let seg = match[0];
            // 去掉"第"和空白
            let core = seg.replace(/^\s*第\s*/, '').trim();
            let parity = match[1] === '单' ? 'odd' : (match[1] === '双' ? 'even' : 'all');
            // 范围：1-5周
            let mRange = core.match(/^(\d+)\s*[-—~]\s*(\d+)\s*周/);
            if(mRange){
                let s = parseInt(mRange[1]), e = parseInt(mRange[2]);
                if(s >= 1 && e >= s && e <= 30){
                    let key = s + '-' + e + '-' + parity;
                    if(!seen[key]){ res.push({start:s, end:e, parity:parity}); seen[key] = 1; }
                }
                continue;
            }
            // 单周：3周 或 第3周
            let mOne = core.match(/^(\d+)\s*周/);
            if(mOne){
                let s = parseInt(mOne[1]);
                if(s >= 1 && s <= 30){
                    let key = s + '-' + s + '-' + parity;
                    if(!seen[key]){ res.push({start:s, end:s, parity:parity}); seen[key] = 1; }
                }
            }
        }
        return res;
    }

    // 获取所有的课程信息，存放到一个 courses 数组中
    // v1.2.0：不再依赖 <p>/<span>/<font> 的具体结构，改为在 div 完整文本上全局正则提取。
    // v1.3.2：节次正则支持 ~；地点/教师提取适配"考查/考试/未安排"行。
    function parseCourses(data){
        var courses = new Array();
        for(let i = 0; i < data.divs.length; ++i){
            let course = new Course();
            course.week = data.week[i];
            course.name = extractCourseName(data.divs[i]);
            if(course.name.length == 0){
                console.log("%c 未能获取课程名，div文本：" + data.divs[i].innerText, "color: red");
            }
            // 取整个div的纯文本，全局搜索节次/周次/地点/教师
            let wholeText = (data.divs[i].innerText || '').replace(/\s+/g, ' ').trim();
            course.info = wholeText;

            // --- 节次：全局搜索 (x-y节) 或 (x节)，支持 - — ~ 分隔 ---
            let mTime = wholeText.match(/[\(（](\d+)\s*[-—~]\s*(\d+)\s*节[\)）]/);
            if(mTime){
                course.startTime = parseInt(mTime[1]);
                course.endTime = parseInt(mTime[2]);
            } else {
                let m1 = wholeText.match(/[\(（](\d+)\s*节[\)）]/);
                if(m1){ course.startTime = course.endTime = parseInt(m1[1]); }
            }

            // --- 周次：全局搜索所有周次段 ---
            course.weekSegments = parseWeekSegments(wholeText);
            course.startWeek = course.weekSegments.map(s => s.start);
            course.endWeek = course.weekSegments.map(s => s.end);
            course.isSingleOrDouble = course.weekSegments.map(s => s.parity === 'all' ? 1 : 2);

            // --- 地点：从"校区"起逐个词块收集，直到遇到不含地点特征的词（教师名/考核方式等）为止 ---
            // 兼容："湖光校区 明德楼b2502(多) 毛华庆 考查"、"湖光校区 篮球场(三辰旁)"、"湖光校区 广学楼210(多)"
            let mLoc = wholeText.match(/(湖光校区|海滨校区|霞山校区|抚州校区)/);
            if(mLoc){
                let after = wholeText.substring(wholeText.indexOf(mLoc[0]) + mLoc[0].length).trim();
                let locWords = [mLoc[0]];
                let parts = after.split(/\s+/);
                for(let p of parts){
                    if(!p) continue;
                    if(/校区|楼|场|馆|中心|教室|实验室|篮球场|操场|^[（(]/.test(p)){
                        locWords.push(p);
                    } else {
                        break;
                    }
                }
                course.location = locWords.join(" ");
            }
            // 更宽松：找"明德楼/广学楼/钟海楼/博文楼/望海楼"等关键词
            if(!course.location){
                let mb = wholeText.match(/(明德楼|广学楼|钟海楼|博文楼|望海楼|篮球场|操场|教室|楼)[A-Za-z0-9(多)楼号]*/);
                if(mb) course.location = mb[0];
            }

            // --- 教师：优先找"教师"后面的人名；兜底取"考查/考核/考试"前的人名（GDOU新页面教师行无"教师"前缀）---
            let mTea = wholeText.match(/教师[:：]?\s*([^，,\s/]+)/);
            if(mTea){ course.teacher = mTea[1].trim(); }
            if(!course.teacher){
                let mt = wholeText.match(/([^，,\s]+(?:,[^，,\s]+)*)\s*(?:考查|考核|考试)/);
                if(mt){ course.teacher = mt[1].trim(); }
            }

            // 兜底：节次默认第1节
            if(!course.startTime){ course.startTime = 1; course.endTime = 1; }
            if(!course.weekSegments || course.weekSegments.length === 0){
                console.warn("%c [周次解析失败] 课程：" + course.name + " | 全文：" + wholeText, "color: orange");
            }
            courses.push(course);
        }
        return courses;
    }

    // 上课时间表（v1.3.2：已按广东海洋大学现行作息更新——节1 08:10 起、每节45分钟；
    // Excel导出不依赖此表，只使用节次编号；课刻专用 xlsx 右侧作息表由此生成）
    var TIME = {
        "1":  { "name": "第1节",  "startTime": { "hour": '08', "minute": '10' } },
        "2":  { "name": "第2节",  "startTime": { "hour": '09', "minute": '00' } },
        "3":  { "name": "第3节",  "startTime": { "hour": '10', "minute": '15' } },
        "4":  { "name": "第4节",  "startTime": { "hour": '11', "minute": '05' } },
        "5":  { "name": "第5节",  "startTime": { "hour": '14', "minute": '30' } },
        "6":  { "name": "第6节",  "startTime": { "hour": '15', "minute": '20' } },
        "7":  { "name": "第7节",  "startTime": { "hour": '16', "minute": '30' } },
        "8":  { "name": "第8节",  "startTime": { "hour": '17', "minute": '20' } },
        "9":  { "name": "第9节",  "startTime": { "hour": '19', "minute": '30' } },
        "10": { "name": "第10节", "startTime": { "hour": '20', "minute": '25' } }
    };

    function getFixedLen(s, len){
        if(s.length < len){
            return getFixedLen("0" + s, len);
        }
        else if(s.length > len){
            return s.slice(0, len);
        }
        else{
            return s;
        }
    }

    function getTime(num, StartOrEnd) {
        if(num < 1) return "000000";   // 防御
        var t = TIME[num] || TIME[1];
        var hour = t.startTime.hour;
        var minute = parseInt(t.startTime.minute) + StartOrEnd;
        if (minute >= 60) {
            minute = minute - 60;
            hour = parseInt(hour) + 1;
        }
        return "" + getFixedLen("" + hour, 2) + getFixedLen("" + minute, 2) + "00";
    }

    function formatDate(d){
        return d.getFullYear() + "-" + getFixedLen("" + (d.getMonth() + 1), 2) + "-" + getFixedLen("" + d.getDate(), 2);
    }

    // 自动对齐周一（V9.0）：把所选日期对齐到本周周一
    function alignToMonday(dateStr){
        let d = dateStr instanceof Date ? new Date(dateStr) : new Date(dateStr.toString());
        if(isNaN(d.getTime())) d = new Date();
        let day = d.getDay();          // 0=周日
        day = day === 0 ? 7 : day;
        d.setDate(d.getDate() - (day - 1));
        return d;
    }

    // 通过周数获得具体的日期（相对学期开始的那一周）
    function getDate(num, wk){
        let date = alignToMonday(startDate);
        date.setDate(date.getDate() + (num - 1) * 7 + Week[wk] - 1);
        let res = "";
        res += getFixedLen(date.getUTCFullYear().toString(), 4);
        res += getFixedLen((date.getUTCMonth() + 1).toString(), 2);
        res += getFixedLen(date.getUTCDate().toString(), 2);
        res += "T";
        return res;
    }

    // 周次文本（Excel用）
    function weeksText(c){
        if(!c.weekSegments || !c.weekSegments.length) return "";
        return c.weekSegments.map(s => {
            let t = s.start === s.end ? s.start + "周" : s.start + "-" + s.end + "周";
            if(s.parity === 'odd') t += "(单)";
            else if(s.parity === 'even') t += "(双)";
            return t;
        }).join(", ");
    }

    // 星期转数字 1-7
    function weekNum(c){
        return (typeof c.week === "number") ? c.week : Week[c.week];
    }

    // RRULE 出现次数：间隔周(单/双)按起始周奇偶交错计数，保证结果为整数
    function countOccurrences(startW, endW, interval){
        if(interval === 1) return endW - startW + 1;
        return Math.floor((endW - startW) / 2) + 1;
    }

    // --------------------------------------------------------------------------
    // 日历的生成，由处理过的课程信息来得到一个ics文件
    function generateCalendar(courses){
        let res = new ICS();
        console.log(courses);
        console.log('======================!!!============================');
        courses.forEach(course => {
            for(let i = 0; i < course.isSingleOrDouble.length; ++i){
                let e = new ICSEvent(
                    "" + getDate(course.startWeek[i], course.week) + getTime(course.startTime, 0),
                    "" + getDate(course.startWeek[i], course.week) + getTime(course.endTime, 45),   // 单节上课时间
                    "" + course.name,                                   // 标题只放课名(V9.0)
                    "" + course.location,                               // 地点
                    "" + (course.teacher ? course.teacher + " " : "") + course.info   // 描述
                );
                e.setRRULE("WEEKLY", res.Calendar.WKST,
                            "" + countOccurrences(course.startWeek[i], course.endWeek[i], course.isSingleOrDouble[i]),
                            "" + course.isSingleOrDouble[i],
                            "" + course.week.substr(0, 2).toUpperCase());
                res.pushEvent(e);
            }
        });
        res.pushCalendarEnd();
        res.exportIcs();
    }

    // ============================ Excel 导出 ============================
    function loadScript(src){
        return new Promise(function(resolve, reject){
            let s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = function(){ reject(new Error("load fail: " + src)); };
            document.head.appendChild(s);
        });
    }

    // 依次尝试多个CDN加载SheetJS（jsdelivr / unpkg / bootcdn / staticfile）
    function loadXLSXFromCDN(){
        let urls = [
            "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
            "https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js",
            "https://cdn.bootcdn.net/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
            "https://cdn.staticfile.net/xlsx/0.18.5/xlsx.full.min.js"
        ];
        let i = 0;
        function tryNext(){
            if(i >= urls.length) return Promise.reject(new Error("all cdn failed"));
            let u = urls[i++];
            return loadScript(u).then(function(){
                let X = (typeof unsafeWindow !== "undefined" && unsafeWindow.XLSX) || window.XLSX;
                if(X) return X;
                return tryNext();
            }).catch(function(){ return tryNext(); });
        }
        return tryNext();
    }

    function exportToExcel(courses){
        if(!courses || courses.length === 0){
            alert("未解析到任何课程信息，请确认当前页面为「学生课表查询」页面并已加载课表。");
            return;
        }
        loadXLSXFromCDN().then(function(XLSX){
            try{
                buildAndSaveWorkbook(XLSX, courses);
                alert("Excel文件已导出：课程表.xlsx（含「课表」周视图与「课程明细」两个工作表）");
            }catch(err){
                console.error("xlsx生成失败：", err);
                fallbackToCSV(courses);
                alert("生成.xlsx失败，已降级导出CSV文件，用Excel/WPS打开即可。");
            }
        }).catch(function(){
            fallbackToCSV(courses);
            alert("未能加载Excel库（CDN不可达），已降级导出CSV文件，用Excel/WPS打开即可。");
        });
    }

    function buildAndSaveWorkbook(XLSX, courses){
        const dayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

        // ---- Sheet1: 课表（周视图：行=节次，列=星期）----
        let maxSection = 10;
        courses.forEach(c => { if(c.endTime > maxSection) maxSection = c.endTime; });

        let grid = {};          // r_col -> 文本
        let cellOwners = {};    // r_col -> 课程索引集合（用于判断是否可合并）
        courses.forEach((c, ci) => {
            let col = weekNum(c);
            let parts = [c.name];
            if(c.location) parts.push(c.location + (c.teacher ? " " + c.teacher : ""));
            else if(c.teacher) parts.push(c.teacher);
            parts.push(weeksText(c));
            let content = parts.join("\n");
            for(let r = c.startTime; r <= c.endTime; r++){
                let key = r + "_" + col;
                grid[key] = grid[key] ? grid[key] + "\n\n" + content : content;
                (cellOwners[key] = cellOwners[key] || new Set()).add(ci);
            }
        });

        let aoa1 = [["节次"].concat(dayNames)];
        for(let r = 1; r <= maxSection; r++){
            let row = ["第" + r + "节"];
            for(let col = 1; col <= 7; col++){
                row.push(grid[r + "_" + col] || "");
            }
            aoa1.push(row);
        }
        let ws1 = XLSX.utils.aoa_to_sheet(aoa1);
        ws1["!cols"] = [{wch: 8}, {wch: 30}, {wch: 30}, {wch: 30}, {wch: 30}, {wch: 30}, {wch: 26}, {wch: 26}];

        // 合并单元格：跨节的同一课程合并（不与其它课程冲突时才合并）
        let merges = [];
        courses.forEach((c, ci) => {
            let col = weekNum(c);
            if(c.endTime > c.startTime){
                let ok = true;
                for(let r = c.startTime; r <= c.endTime; r++){
                    let owners = cellOwners[r + "_" + col];
                    if(!owners || owners.size !== 1 || !owners.has(ci)){ ok = false; break; }
                }
                if(ok) merges.push({s: {r: c.startTime, c: col}, e: {r: c.endTime, c: col}});
            }
        });
        ws1["!merges"] = merges;

        // ---- Sheet2: 课程明细 ----
        let aoa2 = [["序号", "课程名称", "星期", "上课节次", "周次", "单双周", "上课地点", "任课教师", "原始信息"]];
        courses.forEach((c, i) => {
            let col = weekNum(c);
            let segTxts = c.weekSegments.map(s => s.start === s.end ? s.start + "周" : s.start + "-" + s.end + "周");
            let parityTxts = c.weekSegments.map(s => {
                if(s.parity === 'odd') return "单周";
                if(s.parity === 'even') return "双周";
                return "每周";
            });
            aoa2.push([
                i + 1,
                c.name,
                dayNames[col - 1],
                (c.startTime === c.endTime ? "第" + c.startTime + "节" : "第" + c.startTime + "-" + c.endTime + "节"),
                segTxts.join(", "),
                parityTxts.join(", "),
                c.location || "",
                c.teacher || "",
                c.info || ""
            ]);
        });
        let ws2 = XLSX.utils.aoa_to_sheet(aoa2);
        ws2["!cols"] = [{wch: 6}, {wch: 24}, {wch: 8}, {wch: 14}, {wch: 28}, {wch: 16}, {wch: 18}, {wch: 16}, {wch: 32}];

        let wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws1, "课表");
        XLSX.utils.book_append_sheet(wb, ws2, "课程明细");
        // 手动Blob下载，避免依赖SheetJS内部下载实现
        let data = XLSX.write(wb, {bookType: "xlsx", type: "array"});
        let blob = new Blob([data], {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
        let a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "课程表.xlsx";
        a.click();
        setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
    }

    // 降级方案：UTF-8 BOM 的 CSV（Excel/WPS 可直接打开）
    function fallbackToCSV(courses){
        const dayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
        let esc = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
        let lines = [["课程名称", "星期", "上课节次", "周次", "单双周", "上课地点", "任课教师"].join(",")];
        courses.forEach(c => {
            let col = weekNum(c);
            let segTxts = c.weekSegments.map(s => s.start === s.end ? s.start + "周" : s.start + "-" + s.end + "周");
            let parityTxts = c.weekSegments.map(s => s.parity === 'odd' ? "单周" : (s.parity === 'even' ? "双周" : "每周"));
            lines.push([
                esc(c.name),
                esc(dayNames[col - 1]),
                esc(c.startTime === c.endTime ? "第" + c.startTime + "节" : "第" + c.startTime + "-" + c.endTime + "节"),
                esc(segTxts.join(", ")),
                esc(parityTxts.join(", ")),
                esc(c.location || ""),
                esc(c.teacher || "")
            ].join(","));
        });
        let csv = "\ufeff" + lines.join("\r\n");
        let blob = new Blob([csv], {type: "text/csv;charset=utf-8"});
        let a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "课程表.csv";
        a.click();
        setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
    }

    // 右侧 I 列为作息时间表（节次/开始/结束），课刻导入时会自动应用该作息。
    function lessonTimeRows(){
        var rows = [["作息时间", "", ""]];
        for(var num = 1; num <= 10; num++){
            var t = TIME[num] || TIME[1];
            var startHour = parseInt(t.startTime.hour, 10);
            var startMinute = parseInt(t.startTime.minute, 10);
            var endMinute = startMinute + 45;
            var endHour = startHour;
            if(endMinute >= 60){ endMinute -= 60; endHour++; }
            rows.push([
                "第" + num + "节",
                getFixedLen("" + startHour, 2) + ":" + getFixedLen("" + startMinute, 2),
                getFixedLen("" + endHour, 2) + ":" + getFixedLen("" + endMinute, 2)
            ]);
        }
        return rows;
    }

    // ============================ 课刻(desktop-course-widget)格式导出 ============================
    // 课刻 Excel 导入格式：单工作表网格。表头行含"星期X"（列=星期）；首列是节次标签（行=节次）；
    // 每个课程单元格文本格式：课程名\n周次,星期N,第X节-第Y节\n地点。
    // 重要：每个周次段独立成一行、每行都自带"星期N,第X节-第Y节"——
    // 课刻 parse_cell 按周次段切分，段内没有节次/星期文本时只兜底用单元格的行列信息（行节次=单节），
    // 会把跨节课程(如1-2节)误降为单节。逐段写法保证每段信息完整。
    // 周次支持"1-5周,7-8周(单)"、"第3周"、"2-16周(双)"等，与课刻 parse_cell 正则完全兼容。
    function widgetCellText(c){
        const day = weekNum(c);
        const sec = (c.startTime === c.endTime)
            ? "第" + c.startTime + "节"
            : "第" + c.startTime + "节-第" + c.endTime + "节";
        let clauses = [];
        if(!c.weekSegments || c.weekSegments.length === 0){
            // 周次解析失败：不臆造 1-20 周，标注"周次待定"（课刻解析时安全跳过该课程）
            clauses.push("周次待定,星期" + day + "," + sec);
        }
        else{
            // 每个周次段独立成一行，每行自带奇偶标记 + 星期 + 节次
            for(let s of c.weekSegments){
                const w = s.start === s.end ? "第" + s.start + "周" : s.start + "-" + s.end + "周";
                const pw = w + (s.parity === 'odd' ? "(单)" : s.parity === 'even' ? "(双)" : "");
                clauses.push(pw + ",星期" + day + "," + sec);
            }
        }
        let lines = [c.name].concat(clauses);
        lines.push(c.location || "无");
        return lines.join("\n");
    }

    function buildWidgetWorkbook(XLSX, courses){
        const weekHeaders = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];
        let maxSection = 10;
        courses.forEach(c => { if(c.endTime > maxSection) maxSection = c.endTime; });

        let used = {};      // col -> Set(row)
        let cells = {};     // row_col -> 文本
        courses.forEach(c => {
            let col = weekNum(c);
            let row = c.startTime;
            // 同一星期同一节次有多门课时（如调课、不同周次的课），依次下移一行放置，
            // 每格文本都自带完整的"星期N,第X节-第Y节"信息，课刻仍能解析正确
            while((used[col] || (used[col] = new Set())).has(row)) row++;
            used[col].add(row);
            cells[row + "_" + col] = (cells[row + "_" + col]
                ? cells[row + "_" + col] + "\n\n"
                : "") + widgetCellText(c);
        });

        let aoa = [["节次"].concat(weekHeaders)];
        for(let r = 1; r <= maxSection; r++){
            let row = ["第" + r + "节"];
            for(let col = 1; col <= 7; col++){
                row.push(cells[r + "_" + col] || "");
            }
            aoa.push(row);
        }
        let ws = XLSX.utils.aoa_to_sheet(aoa);
        ws["!cols"] = [{wch: 8}, {wch: 34}, {wch: 34}, {wch: 34}, {wch: 34}, {wch: 34}, {wch: 30}, {wch: 30}, {wch: 10}, {wch: 10}, {wch: 10}];
        // I 列附作息时间表（节次/开始/结束），课刻导入自动应用
        XLSX.utils.sheet_add_aoa(ws, lessonTimeRows(), { origin: "I1" });
        let wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "课表");
        let data = XLSX.write(wb, {bookType: "xlsx", type: "array"});
        let blob = new Blob([data], {type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
        let a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "课刻-课程表.xlsx";
        a.click();
        setTimeout(function(){ URL.revokeObjectURL(a.href); }, 1000);
    }

    function exportToWidget(courses){
        if(!courses || courses.length === 0){
            alert("未解析到任何课程信息，请确认当前页面为「学生课表查询」页面并已加载课表。");
            return;
        }
        loadXLSXFromCDN().then(function(XLSX){
            try{
                buildWidgetWorkbook(XLSX, courses);
                alert("课刻格式Excel已导出：课刻-课程表.xlsx（含右侧作息时间表，导入课刻自动应用作息）。\n在课刻(desktop-course-widget)中点击「导入新课表」选择该文件即可。");
            }catch(err){
                console.error("课刻xlsx生成失败：", err);
                alert("生成失败：" + (err && err.message ? err.message : err));
            }
        }).catch(function(){
            alert("未能加载Excel库（CDN不可达），无法生成课刻格式xlsx，请联网后重试。");
        });
    }
    // ============================ 课刻格式导出结束 ============================
}

// -------------------------------- ICS类，用于处理所有有关日历的操作 ------------------------------------------//
var CRLF = "\n";
var SPACE = " ";
class ICS{

    Calendar;       // 日历参数
    ics;            // ics格式的日历
    res;            // 最后格式化的结果

    constructor(){
        (function(Calendar){
            Calendar.PRODID = "-//31415926535x//ICalendar Exporter v1.0//CN";
            Calendar.VERSION = "2.0";
            Calendar.CALSCALE = "GREGORIAN";        // 历法，默认是公历
            Calendar.TIMEZONE = "Asia/Shanghai";    // 时区，默认是上海
            Calendar.ISVALARM = true;               // 提醒，默认是开启
            Calendar.VALARM = "-PT0D0H10M0S";       // 提醒，默认10分钟
            Calendar.WKST = "SU";                   // 一周开始，默认是周日
        })(this.Calendar || (this.Calendar = {}));

        this.ics = new Array();
        this.ics.push("BEGIN:VCALENDAR");
        this.ics.push("VERSION:" + this.Calendar.VERSION);
        this.ics.push("PRODID:" + this.Calendar.PRODID);
        this.ics.push("CALSCALE:" + this.Calendar.CALSCALE);
    }

    // 添加事件
    pushEvent(e){
        this.ics.push("BEGIN:VEVENT");
        this.ics.push(e.getDTSTART());
        this.ics.push(e.getDTEND());
        if(e.isrrule == true)this.ics.push(e.getRRULE());
        this.ics.push(e.getSUMMARY());
        this.ics.push(e.getLOCATION());
        this.ics.push(e.getDESCRIPTION());
        if(this.Calendar.ISVALARM == true)this.pushAlarm();
        this.ics.push("END:VEVENT");
        this.ics.push(CRLF);
    }

    // 添加提醒
    pushAlarm(){
        this.ics.push("BEGIN:VALARM");
        this.ics.push("ACTION:DISPLAY");
        this.ics.push("TRIGGER:" + this.Calendar.VALARM);
        this.ics.push("END:VALARM");
    }

    // 添加日历末
    pushCalendarEnd(){
        this.ics.push("END:VCALENDAR");
    }

    // 对ics进行格式的处理，超长行按RFC5545折行，续行以空格开头
    getFixedIcs(){
        this.res = "";
        this.ics.forEach(line => {
            let bytes = unescape(encodeURIComponent(line)).length;   // 近似字节数
            if(bytes > 70){
                let cur = "", parts = [];
                for(let ch of line){
                    cur += ch;
                    if(unescape(encodeURIComponent(cur)).length >= 60){
                        parts.push(cur); cur = "";
                    }
                }
                if(cur) parts.push(cur);
                parts.forEach((part, idx) => {
                    this.res += (idx === 0 ? "" : SPACE) + part + CRLF;
                });
            }
            else{
                this.res += line + CRLF;
            }
        });
        return this.res;
    }

    // 导出ics
    exportIcs(){
        this.getFixedIcs();
        let link = window.URL.createObjectURL(new Blob([this.res], {
            type: "text/x-vCalendar"
        }));
        let a = document.createElement("a");
        a.setAttribute("href", link);
        a.setAttribute("download", "courses.ics");
        a.click();
    }
}
// -------------------------------- ICS类，用于处理所有有关日历的操作 ------------------------------------------//
class ICSEvent{
    constructor(DTSTART, DTEND, SUMMARY, LOCATION, DESCRIPTION){
        this.DTSTART = DTSTART;
        this.DTEND = DTEND;
        this.SUMMARY = SUMMARY;
        this.LOCATION = LOCATION;
        this.DESCRIPTION = DESCRIPTION;
    }
    isrrule = false;
    RRULE;
    setRRULE(FREQ, WKST, COUNT, INTERVAL, BYDAY){
        this.isrrule = true;
        this.RRULE = "RRULE:FREQ=" + FREQ + ";WKST=" + WKST + ";COUNT=" + COUNT + ";INTERVAL=" + INTERVAL + ";BYDAY=" + BYDAY;
    }
    getRRULE(){
        return "" + this.RRULE;
    }
    getDTSTART(){
        return "DTSTART:" + this.DTSTART;
    }
    getDTEND(){
        return "DTEND:" + this.DTEND;
    }
    getSUMMARY(){
        return "SUMMARY:" + this.SUMMARY;
    }
    getLOCATION(){
        return "LOCATION:" + this.LOCATION;
    }
    getDESCRIPTION(){
        return "DESCRIPTION:" + this.DESCRIPTION;
    }
}
//（注：内容由AI生成）
