export function convertToDanmakuJson(contents, platform) {
  let danmus = [];
  let cidCounter = 1;

  // 统一处理输入为数组
  let items = [];
  if (typeof contents === "string") {
    // 处理 XML 字符串
    items = [...contents.matchAll(/<d p="([^"]+)">([^<]+)<\/d>/g)].map(match => ({
      p: match[1],
      m: match[2]
    }));
  } else if (contents && Array.isArray(contents.danmuku)) {
    // 处理 danmuku 数组，映射为对象格式
    const typeMap = { right: 1, top: 4, bottom: 5 };
    const hexToDecimal = (hex) => (hex ? parseInt(hex.replace("#", ""), 16) : 16777215);
    items = contents.danmuku.map(item => ({
      timepoint: item[0],
      ct: typeMap[item[1]] !== undefined ? typeMap[item[1]] : 1,
      color: hexToDecimal(item[2]),
      content: item[4]
    }));
  } else if (Array.isArray(contents)) {
    // 处理标准对象数组
    items = contents;
  }

  if (!items.length) {
    // 如果是空数组，直接返回空数组，不抛出异常
    // 这样可以让兜底逻辑有机会执行
    return [];
  }

  for (const item of items) {
    let attributes, m;
    let time, mode, color;

    // 新增：处理新格式的弹幕数据
    if ("progress" in item && "mode" in item && "content" in item) {
      // 处理新格式的弹幕对象
      time = (item.progress / 1000).toFixed(2);
      mode = item.mode || 1;
      color = item.color || 16777215;
      m = item.content;
    } else if ("timepoint" in item) {
      // 处理对象数组输入
      time = parseFloat(item.timepoint).toFixed(2);
      mode = item.ct || 0;
      color = item.color || 16777215;
      m = item.content;
    } else {
      if (!("p" in item)) {
        continue;
      }
      // 处理 XML 解析后的格式
      const pValues = item.p.split(",");
      time = parseFloat(pValues[0]).toFixed(2);
      mode = pValues[1] || 0;

      // 支持多种格式的 p 属性
      // 旧格式（4字段）：时间,类型,颜色,来源
      // 标准格式（8字段）：时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID
      // Bilibili格式（9字段）：时间,类型,字体,颜色,时间戳,弹幕池,用户Hash,弹幕ID,权重
      if (pValues.length === 4) {
        // 旧格式
        color = pValues[2] || 16777215;
      } else if (pValues.length >= 8) {
        // 新标准格式（8字段或9字段）
        color = pValues[3] || 16777215;
      } else {
        // 其他格式，尝试从第3或第4位获取颜色
        color = pValues[3] || pValues[2] || 16777215;
      }
      m = item.m;
    }

    attributes = [
      time,
      mode,
      color,
      `[${platform}]`
    ].join(",");

    danmus.push({ p: attributes, m, cid: cidCounter++ });
  }

  // 切割字符串成正则表达式数组
  const regexArray = globals.blockedWords.split(/(?<=\/),(?=\/)/).map(str => {
    // 去除两端的斜杠并转换为正则对象
    const pattern = str.trim();
    if (pattern.startsWith('/') && pattern.endsWith('/')) {
      try {
        // 去除两边的 `/` 并转化为正则
        return new RegExp(pattern.slice(1, -1));
      } catch (e) {
        log("error", `无效的正则表达式: ${pattern}`, e);
        return null;
      }
    }
    return null; // 如果不是有效的正则格式则返回 null
  }).filter(regex => regex !== null); // 过滤掉无效的项

  log("info", `原始屏蔽词字符串: ${globals.blockedWords}`);
  const regexArrayToString = array => Array.isArray(array) ? array.map(regex => regex.toString()).join('\n') : String(array);
  log("info", `屏蔽词列表: ${regexArrayToString(regexArray)}`);

  // 过滤列表
  const filteredDanmus = danmus.filter(item => {
    return !regexArray.some(regex => regex.test(item.m)); // 针对 `m` 字段进行匹配
  });

  // 按n分钟内去重
  log("info", `去重分钟数: ${globals.groupMinute}`);
  const groupedDanmus = groupDanmusByMinute(filteredDanmus, globals.groupMinute);

  // 应用弹幕转换规则（在去重和限制弹幕数之后）
  let convertedDanmus = limitDanmusByCount(groupedDanmus, globals.danmuLimit);
  if (globals.convertTopBottomToScroll || globals.convertColor === 'white' || globals.convertColor === 'color') {
    let topBottomCount = 0;
    let colorCount = 0;

    convertedDanmus = groupedDanmus.map(danmu => {
      const pValues = danmu.p.split(',');
      if (pValues.length < 3) return danmu;

      let mode = parseInt(pValues[1], 10);
      let color = parseInt(pValues[2], 10);
      let modified = false;

      // 1. 将顶部/底部弹幕转换为浮动弹幕
      if (globals.convertTopBottomToScroll && (mode === 4 || mode === 5)) {
        topBottomCount++;
        mode = 1;
        modified = true;
      }

      // 2. 弹幕转换颜色
      // 2.1 将彩色弹幕转换为白色
      if (globals.convertColor === 'white' && color !== 16777215) {
        colorCount++;
        color = 16777215;
        modified = true;
      }
      // 2.2 将白色弹幕转换为随机颜色，白、红、橙、黄、绿、青、蓝、紫、粉（模拟真实情况，增加白色出现概率）
      let colors = [16777215, 16777215, 16777215, 16777215, 16777215, 16777215, 16777215, 16777215, 
                    16744319, 16752762, 16774799, 9498256, 8388564, 8900346, 14204888, 16758465];
      let randomColor = colors[Math.floor(Math.random() * colors.length)];
      if (globals.convertColor === 'color' && color === 16777215) {
        colorCount++;
        color = randomColor;
        modified = true;
      }

      if (modified) {
        const newP = [pValues[0], mode, color, ...pValues.slice(3)].join(',');
        return { ...danmu, p: newP };
      }
      return danmu;
    });

    // 统计输出转换结果
    if (topBottomCount > 0) {
      log("info", `[danmu convert] 转换了 ${topBottomCount} 条顶部/底部弹幕为浮动弹幕`);
    }
    if (colorCount > 0) {
      log("info", `[danmu convert] 转换了 ${colorCount} 条弹幕颜色`);
    }
  }

  log("info", `danmus_original: ${danmus.length}`);
  log("info", `danmus_filter: ${filteredDanmus.length}`);
  log("info", `danmus_group: ${groupedDanmus.length}`);
  log("info", `danmus_limit: ${convertedDanmus.length}`);
  // 输出前五条弹幕
  log("info", "Top 5 danmus:", JSON.stringify(convertedDanmus.slice(0, 5), null, 2));

  // ========== 修复后的广告插入逻辑（保证任何情况下都能运行） ==========
  // 确保 convertedDanmus 是数组
  if (!Array.isArray(convertedDanmus)) {
    convertedDanmus = [];
  }

  // 提取有效时间点和 cid（过滤掉没有 t 或 t 非数字的项）
  const validTimes = convertedDanmus.filter(d => d && typeof d.t === 'number').map(d => d.t);
  const validCids = convertedDanmus.filter(d => d && typeof d.cid === 'number').map(d => d.cid);

  const maxTime = validTimes.length > 0 ? Math.max(...validTimes) : 0;
  const maxCid = validCids.length > 0 ? Math.max(...validCids) : 0;

  const adMode = 6; // 反向滚动
  const adColor = 16711680; // 红色
  const adContent = "弹幕内容由余影科技收集整理弹出–www.8688688.xyz";
  const platformTag = `[${platform}]`;

  // 生成广告弹幕列表
  const adDanmus = [];
  let adCid = maxCid + 1;

  // 从0秒开始，每隔600秒插入一条，直到 maxTime
  for (let time = 0; time <= maxTime; time += 600) {
    const p = `${time.toFixed(2)},${adMode},${adColor},${platformTag}`;
    adDanmus.push({
      cid: adCid++,
      p: p,
      m: adContent,
      t: time
    });
  }

  // 如果原始弹幕为空，至少保留一条广告
  if (adDanmus.length === 0) {
    adDanmus.push({
      cid: 1,
      p: `0.00,${adMode},${adColor},${platformTag}`,
      m: adContent,
      t: 0
    });
  }

  // 合并广告和原始弹幕
  convertedDanmus = [...convertedDanmus, ...adDanmus];

  // 按时间排序
  convertedDanmus.sort((a, b) => a.t - b.t);
  // ========== 广告插入结束 ==========

  return convertedDanmus;
}
