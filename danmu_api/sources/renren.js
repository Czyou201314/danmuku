import BaseSource from './base.js';
import { globals } from '../configs/globals.js';
import { log } from "../utils/log-util.js";
import { getPathname, httpGet, sortedQueryString, updateQueryString } from "../utils/http-util.js";
import { autoDecode, createHmacSha256, generateSign } from "../utils/codec-util.js";
import { generateValidStartDate } from "../utils/time-util.js";
import { addAnime, removeEarliestAnime } from "../utils/cache-util.js";
import { titleMatches } from "../utils/common-util.js";
import { SegmentListResponse } from '../models/dandan-model.js';

// =====================
// 获取人人视频弹幕
// =====================

// 模块级状态管理
let CACHED_ALI_ID = null;
let REQUEST_COUNT = 0;
let ROTATION_THRESHOLD = 0;

export default class RenrenSource extends BaseSource {
  constructor() {
    super();
    this.isBatchMode = false;
  }

  API_CONFIG = {
    SECRET_KEY: "cf65GPholnICgyw1xbrpA79XVkizOdMq",
    TV_HOST: "api.gorafie.com",
    TV_DANMU_HOST: "static-dm.qwdjapp.com",
    TV_VERSION: "1.2.2",
    TV_USER_AGENT: 'okhttp/3.12.13',
    TV_CLIENT_TYPE: 'android_qwtv_RRSP',
    TV_PKT: 'rrmj',
    WEB_HOST: "api.rrmj.plus",
    WEB_DANMU_HOST: "static-dm.rrmj.plus"
  };

  generateRandomAliId() {
    const prefix = "aY";
    const length = 24 - prefix.length;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = prefix;
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  rotateAliId() {
    const oldId = CACHED_ALI_ID;
    CACHED_ALI_ID = this.generateRandomAliId();
    REQUEST_COUNT = 0;
    ROTATION_THRESHOLD = Math.floor(Math.random() * (60 - 30 + 1)) + 30;
    
    if (oldId) {
        log("info", `[Renren] AliID 轮换完成: ${oldId} -> ${CACHED_ALI_ID}`);
    } else {
        log("info", `[Renren] AliID 初始化完成: ${CACHED_ALI_ID}`);
    }
    log("info", `[Renren] AliID 下次轮换将在 ${ROTATION_THRESHOLD} 次操作后触发`);
  }

  checkAndIncrementUsage() {
    if (!CACHED_ALI_ID) {
      this.rotateAliId();
    }

    if (REQUEST_COUNT >= ROTATION_THRESHOLD) {
      log("info", `[Renren] AliID 触发阈值 (${REQUEST_COUNT}/${ROTATION_THRESHOLD})，正在轮换 ID...`);
      this.rotateAliId();
    }

    REQUEST_COUNT++;
    log("info", `[Renren] AliID 计数增加: ${REQUEST_COUNT}/${ROTATION_THRESHOLD} (当前ID: ...${CACHED_ALI_ID.slice(-6)})`);
  }

  getAliId() {
    if (!CACHED_ALI_ID) {
      this.rotateAliId();
    }

    if (this.isBatchMode) {
      return CACHED_ALI_ID;
    }

    this.checkAndIncrementUsage();
    return CACHED_ALI_ID;
  }

  generateTvHeaders(timestamp, sign) {
    const aliId = this.getAliId();

    return {
      'clientVersion': this.API_CONFIG.TV_VERSION,
      'p': 'Android',
      'deviceid': 'tWEtIN7JG2DTDkBBigvj6A%3D%3D',
      'token': '',
      'aliid': aliId,
      'umid': '',
      'clienttype': this.API_CONFIG.TV_CLIENT_TYPE,
      'pkt': this.API_CONFIG.TV_PKT,
      't': timestamp.toString(),
      'sign': sign,
      'isAgree': '1',
      'et': '2',
      'Accept-Encoding': 'gzip',
      'User-Agent': this.API_CONFIG.TV_USER_AGENT,
    };
  }

  async searchAppContent(keyword, size = 30) {
    try {
      const timestamp = Date.now();
      const path = "/qwtv/search";
      const queryParams = {
        searchWord: keyword,
        num: size,
        searchNext: "",
        well: "match"
      };

      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.SECRET_KEY);
      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v === null || v === undefined ? "" : String(v))}`)
        .join('&');
      
      const headers = this.generateTvHeaders(timestamp, sign);
      const url = `https://${this.API_CONFIG.TV_HOST}${path}?${queryString}`;

      const resp = await httpGet(url, {
        headers: headers,
        retries: 1,
      });

      if (!resp.data || resp.data.code !== "0000") {
        log("info", `[Renren] TV搜索接口异常: code=${resp?.data?.code}, msg=${resp?.data?.msg}`);
        return [];
      }

      const list = resp.data.data || [];
      log("info", `[Renren] TV搜索返回结果数量: ${list.length}`);

      return list.map((item) => ({
        provider: "renren",
        mediaId: String(item.id),
        title: String(item.title || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
        type: item.classify || "Renren",
        season: null,
        year: item.year,
        imageUrl: item.cover,
        episodeCount: null,
        currentEpisodeIndex: null,
      }));
    } catch (error) {
      log("info", "[Renren] searchAppContent error:", error.message);
      return [];
    }
  }

  async getAppDramaDetail(dramaId, episodeSid = "") {
    try {
      const timestamp = Date.now();
      const path = "/qwtv/drama/details";
      const queryParams = {
        isAgeLimit: "false",
        seriesId: dramaId,
        episodeId: episodeSid,
        clarity: "HD",
        caption: "0",
        hevcOpen: "1"
      };

      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.SECRET_KEY);
      const queryString = Object.entries(queryParams)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');
      
      const headers = this.generateTvHeaders(timestamp, sign);

      const resp = await httpGet(`https://${this.API_CONFIG.TV_HOST}${path}?${queryString}`, {
        headers: headers,
        retries: 1,
      });

      if (!resp || !resp.data) {
        log("info", `[Renren] TV详情接口网络无响应或数据为空: ID=${dramaId}`);
        return null;
      }
      
      const resData = resp.data;
      const msg = resData.msg || resData.message || "";

      if (msg.includes("该剧暂不可播")) {
          log("info", `[Renren] TV接口提示'该剧暂不可播' (ID=${dramaId})，触发Web降级`);
          return null;
      }

      if (resData.code !== "0000") {
        log("info", `[Renren] TV详情接口返回错误码: ${resData.code}, msg=${msg} (ID=${dramaId})`);
        return null;
      }

      if (!resData.data || !resData.data.episodeList || resData.data.episodeList.length === 0) {
        log("info", `[Renren] TV详情接口返回数据缺失分集列表 (ID=${dramaId})，尝试Web降级`);
        return null;
      }

      log("info", `[Renren] TV详情获取成功: ID=${dramaId}, 包含集数=${resData.data.episodeList.length}`);
      return resData;
    } catch (error) {
      log("info", "[Renren] getAppDramaDetail error:", error.message);
      return null;
    }
  }

  async getAppDanmu(episodeSid) {
    try {
      const timestamp = Date.now();
      
      let realEpisodeId = episodeSid;
      if (String(episodeSid).includes("-")) {
        realEpisodeId = String(episodeSid).split("-")[1];
      }

      const path = `/v1/produce/danmu/EPISODE/${realEpisodeId}`;
      const queryParams = {};
      const sign = generateSign(path, timestamp, queryParams, this.API_CONFIG.SECRET_KEY);
      const headers = this.generateTvHeaders(timestamp, sign);

      const url = `https://${this.API_CONFIG.TV_DANMU_HOST}${path}`;

      const resp = await httpGet(url, {
        headers: headers,
        retries: 1,
      });

      if (!resp.data) return [];
      
      const data = autoDecode(resp.data);
      
      let danmuList = [];
      if (Array.isArray(data)) danmuList = data;
      else if (data && data.data && Array.isArray(data.data)) danmuList = data.data;

      return danmuList.filter(item => item != null);
    } catch (error) {
      log("info", "[Renren] getAppDanmu error:", error.message);
      return [];
    }
  }

  async getWebDanmuFallback(id) {
    let realEpisodeId = id;
    if (String(id).includes("-")) {
      realEpisodeId = String(id).split("-")[1];
    }
    
    log("info", `[Renren] 降级网页版弹幕，使用 ID: ${realEpisodeId}`);

    const ClientProfile = {
      user_agent: "Mozilla/5.0",
      origin: "https://rrsp.com.cn",
      referer: "https://rrsp.com.cn/",
    };
    
    const url = `https://${this.API_CONFIG.WEB_DANMU_HOST}/v1/produce/danmu/EPISODE/${realEpisodeId}`;
    const headers = {
      "Accept": "application/json",
      "User-Agent": ClientProfile.user_agent,
      "Origin": ClientProfile.origin,
      "Referer": ClientProfile.referer,
    };
    
    try {
      const fallbackResp = await this.renrenHttpGet(url, { headers });
      if (!fallbackResp.data) return [];
      
      const data = autoDecode(fallbackResp.data);
      let list = [];
      if (Array.isArray(data)) list = data;
      else if (data?.data && Array.isArray(data.data)) list = data.data;
      
      return list.filter(item => item != null);
    } catch (e) {
      log("info", `[Renren] 网页版弹幕降级失败: ${e.message}`);
      return [];
    }
  }

  async performNetworkSearch(keyword, { lockRef = null, lastRequestTimeRef = { value: 0 }, minInterval = 500 } = {}) {
    try {
      log("info", `[Renren] 尝试执行网页版搜索: ${keyword}`);
      const url = `https://${this.API_CONFIG.WEB_HOST}/m-station/search/drama`;
      const params = { 
        keywords: keyword, 
        size: 20, 
        order: "match", 
        search_after: "", 
        isExecuteVipActivity: true 
      };

      if (lockRef) {
        while (lockRef.value) await new Promise(r => setTimeout(r, 50));
        lockRef.value = true;
      }

      const now = Date.now();
      const dt = now - lastRequestTimeRef.value;
      if (dt < minInterval) await new Promise(r => setTimeout(r, minInterval - dt));

      const resp = await this.renrenRequest("GET", url, params);
      lastRequestTimeRef.value = Date.now();

      if (lockRef) lockRef.value = false;

      if (!resp.data) {
        log("info", "[Renren] 网页版搜索无响应数据");
        return [];
      }

      const decoded = autoDecode(resp.data);
      const list = decoded?.data?.searchDramaList || [];
      log("info", `[Renren] 网页版搜索结果数量: ${list.length}`);
      
      return list.map((item) => ({
        provider: "renren",
        mediaId: String(item.id),
        title: String(item.title || "").replace(/<[^>]+>/g, "").replace(/:/g, "："),
        type: item.classify || "Renren",
        season: null,
        year: item.year,
        imageUrl: item.cover,
        episodeCount: item.episodeTotal,
        currentEpisodeIndex: null,
      }));
    } catch (error) {
      log("info", "[Renren] performNetworkSearch error:", error.message);
      return [];
    }
  }

  // =====================
  // 标准接口实现
  // =====================

  async search(keyword) {
    log("info", `[Renren] 开始搜索: ${keyword}`);
    const parsedKeyword = { title: keyword, season: null };
    const searchTitle = parsedKeyword.title;
    const searchSeason = parsedKeyword.season;

    let allResults = [];
    
    allResults = await this.searchAppContent(searchTitle);
    
    if (allResults.length === 0) {
      log("info", "[Renren] TV 搜索无结果，降级到网页接口");
      const lock = { value: false };
      const lastRequestTime = { value: 0 };
      allResults = await this.performNetworkSearch(searchTitle, { 
        lockRef: lock, 
        lastRequestTimeRef: lastRequestTime, 
        minInterval: 400 
      });
    }

    if (searchSeason == null) return allResults;

    return allResults.filter(r => r.season === searchSeason);
  }

  async getDetail(id) {
    const resp = await this.getAppDramaDetail(String(id));
    if (resp && resp.data) {
      return resp.data;
    }
    
    log("info", `[Renren] TV详情不可用，尝试请求网页版接口 (ID=${id})`); 
    const url = `https://${this.API_CONFIG.WEB_HOST}/m-station/drama/page`;
    const params = { hsdrOpen: 0, isAgeLimit: 0, dramaId: String(id), hevcOpen: 1 };
    
    try {
      const fallbackResp = await this.renrenRequest("GET", url, params);
      if (!fallbackResp.data) return null;
      
      const decoded = autoDecode(fallbackResp.data);
      if (decoded && decoded.data) {
         log("info", `[Renren] 网页版详情获取成功: 包含集数=${decoded.data.episodeList ? decoded.data.episodeList.length : 0}`);
         return decoded.data;
      }
      return null;
    } catch (e) {
      log("info", `[Renren] 网页版详情请求失败: ${e.message}`);
      return null;
    }
  }

  async getEpisodes(id) {
    log("info", `[Renren] 正在获取分集信息: ID=${id}`);
    const detail = await this.getDetail(id);
    
    if (!detail) {
      log("info", `[Renren] 获取分集失败: 详情对象为空 ID=${id}`);
      return [];
    }
    
    if (!detail.episodeList || !Array.isArray(detail.episodeList)) {
       log("info", `[Renren] 获取分集失败: episodeList 字段缺失或非数组 ID=${id}`);
       return [];
    }

    let episodes = [];
    const seriesId = String(id); 

    detail.episodeList.forEach((ep, idx) => {
      const epSid = String(ep.sid || "").trim();
      if (!epSid) return;
      
      const showTitle = ep.title ? String(ep.title) : `第${String(ep.episodeNo || idx + 1).padStart(2, "0")}集`;
      const compositeId = `${seriesId}-${epSid}`;

      episodes.push({ sid: compositeId, order: ep.episodeNo || idx + 1, title: showTitle });
    });

    log("info", `[Renren] 成功解析分集数量: ${episodes.length} (ID=${id})`);

    return episodes.map(e => ({
      provider: "renren",
      episodeId: e.sid,
      title: e.title,
      episodeIndex: e.order,
      url: null
    }));
  }

  async handleAnimes(sourceAnimes, queryTitle, curAnimes) {
    const tmpAnimes = [];

    if (!sourceAnimes || !Array.isArray(sourceAnimes)) {
      log("info", "[Renren] sourceAnimes is not a valid array");
      return [];
    }

    this.isBatchMode = true;
    
    try {
      await Promise.all(sourceAnimes
        .filter(s => titleMatches(s.title, queryTitle))
        .map(async (anime) => {
          try {
            const eps = await this.getEpisodes(anime.mediaId);
            
            let links = [];
            for (const ep of eps) {
              links.push({
                "name": ep.episodeIndex.toString(),
                "url": ep.episodeId,
                "title": `【${ep.provider}】 ${ep.title}`
              });
            }

            if (links.length > 0) {
              let transformedAnime = {
                animeId: Number(anime.mediaId),
                bangumiId: String(anime.mediaId),
                animeTitle: `${anime.title}(${anime.year})【${anime.type}】from renren`,
                type: anime.type,
                typeDescription: anime.type,
                imageUrl: anime.imageUrl,
                startDate: generateValidStartDate(anime.year),
                episodeCount: links.length,
                rating: 0,
                isFavorited: true,
                source: "renren",
              };

              tmpAnimes.push(transformedAnime);
              addAnime({ ...transformedAnime, links: links });

              if (globals.animes.length > globals.MAX_ANIMES) {
                removeEarliestAnime();
              }
            }
          } catch (error) {
            log("info", `[Renren] Error processing anime: ${error.message}`);
          }
        })
      );
    } finally {
      this.isBatchMode = false;
      this.checkAndIncrementUsage();
    }

    this.sortAndPushAnimesByYear(tmpAnimes, curAnimes);

    return tmpAnimes;
  }

  async getEpisodeDanmu(id) {
    let danmuList = await this.getAppDanmu(id);
    
    if (!danmuList || danmuList.length === 0) {
       log("info", "[Renren] TV 弹幕接口失败或无数据，尝试降级网页接口");
       danmuList = await this.getWebDanmuFallback(id);
    }
    
    if (danmuList && Array.isArray(danmuList) && danmuList.length > 0) {
      log("info", `[Renren] 成功获取 ${danmuList.length} 条弹幕`);
      return danmuList;
    }

    return [];
  }

  async getEpisodeDanmuSegments(id) {
    return new SegmentListResponse({
      "type": "renren",
      "segmentList": [{
        "type": "renren",
        "segment_start": 0,
        "segment_end": 30000,
        "url": id
      }]
    });
  }

  async getEpisodeSegmentDanmu(segment) {
    return this.getEpisodeDanmu(segment.url);
  }

  // =====================
  // 数据解析与签名工具
  // =====================

  /**
   * 格式化弹幕列表为标准模型
   * 强制构建至少9字段的标准p字符串（8标准字段+来源标签），确保客户端解析不会越界
   */
  formatComments(comments) {
    if (!Array.isArray(comments)) return [];

    return comments
      .filter(item => item != null)
      .map(item => {
        const text = String(item.d || item.content || '');
        if (!text) return null;
        if (!item.p) return null;

        // 解析原始p字段
        const parts = String(item.p).split(',');
        
        // 确保至少有8个字段，缺失补默认值
        const timestamp = parseFloat(parts[0]) || 0;          // 时间（秒）
        const mode = parseInt(parts[1]) || 1;                 // 弹幕类型（1=滚动，4=底部，5=顶部）
        const fontSize = parseInt(parts[2]) || 25;            // 字体大小（默认25）
        const color = parseInt(parts[3]) || 16777215;         // 颜色（默认白色）
        
        // 后续字段（用于弹幕ID生成，不影响显示）
        const fallbackTs = Math.floor(Date.now() / 1000);     // 当前时间戳作为备用
        const tsField = parts[4] || fallbackTs;               // 弹幕时间戳
        const pool = parts[5] || '0';                          // 弹幕池（0普通）
        const userHash = parts[6] || '0';                      // 用户Hash
        
        // 弹幕ID：优先使用原始第7个字段，若不存在则生成一个唯一ID
        let danmuId = parts[7];
        if (!danmuId) {
          danmuId = `${fallbackTs}${Math.floor(Math.random() * 10000)}`;
        }

        // 构建标准8字段p字符串，并追加来源标签 [renren]（作为第9字段，符合Bilibili扩展格式）
        const standardP = `${timestamp.toFixed(2)},${mode},${fontSize},${color},${tsField},${pool},${userHash},${danmuId},[renren]`;

        return {
          cid: Number(danmuId) || 0,
          p: standardP,
          m: text,
          t: timestamp
        };
      })
      .filter(item => item != null);
  }

  generateSignature(method, aliId, ct, cv, timestamp, path, sortedQuery, secret) {
    const signStr = `${method.toUpperCase()}\naliId:${aliId}\nct:${ct}\ncv:${cv}\nt:${timestamp}\n${path}?${sortedQuery}`;
    return createHmacSha256(secret, signStr);
  }

  buildSignedHeaders({ method, url, params = {}, deviceId, token }) {
    const ClientProfile = {
      client_type: "web_pc",
      client_version: "1.0.0",
      user_agent: "Mozilla/5.0",
      origin: "https://rrsp.com.cn",
      referer: "https://rrsp.com.cn/",
    };
    const pathname = getPathname(url);
    const qs = sortedQueryString(params);
    const nowMs = Date.now();
    const SIGN_SECRET = "ES513W0B1CsdUrR13Qk5EgDAKPeeKZY";
    const xCaSign = this.generateSignature(
      method, deviceId, ClientProfile.client_type, ClientProfile.client_version,
      nowMs, pathname, qs, SIGN_SECRET
    );
    return {
      clientVersion: ClientProfile.client_version,
      deviceId,
      clientType: ClientProfile.client_type,
      t: String(nowMs),
      aliId: deviceId,
      umid: deviceId,
      token: token || "",
      cv: ClientProfile.client_version,
      ct: ClientProfile.client_type,
      uet: "9",
      "x-ca-sign": xCaSign,
      Accept: "application/json",
      "User-Agent": ClientProfile.user_agent,
      Origin: ClientProfile.origin,
      Referer: ClientProfile.referer,
    };
  }

  async renrenHttpGet(url, { params = {}, headers = {} } = {}) {
    const u = updateQueryString(url, params);
    const resp = await httpGet(u, {
      headers: headers,
      retries: 1,
    });
    return resp;
  }

  generateDeviceId() {
    return (Math.random().toString(36).slice(2)).toUpperCase();
  }

  async renrenRequest(method, url, params = {}) {
    const deviceId = this.generateDeviceId();
    const headers = this.buildSignedHeaders({ method, url, params, deviceId });
    const resp = await httpGet(url + "?" + sortedQueryString(params), {
      headers: headers,
      retries: 1,
    });
    return resp;
  }
}
