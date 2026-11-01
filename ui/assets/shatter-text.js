/**
 * ui/assets/shatter-text.js — 「碎裂」模式的字与屑。
 *
 * 一行字先在离屏画布上按当前字体/字号烘成一张图；唱完那一刻把它切成小方块
 * 粒子（只保留有笔画的那几块），每片带一点初速、旋转、空气阻力与重力，
 * 再按各自的寿命淡出。画布本体铺满面板，粒子从字的位置往外飘、往下沉，
 * 落出面板底边就回收。
 *
 * 为什么整句走 canvas 而不是 DOM：碎片必须与整句**像素级**对得上，
 * 否则爆开那一帧会「跳一下」。字与屑来自同一张图，接缝就看不出来。
 *
 * 这个文件只管画，不管时间轴：谁调 tick(dt) 谁决定节奏（面板那边是
 * requestAnimationFrame 循环，试验页可以按固定步长手动推进，方便截静帧）。
 */

const MAX_DPR = 2;
/** 一句太宽时允许整体缩到多小（再小就截字加省略号）。 */
const MIN_SCALE = 0.78;

/** 傲雪（原名散雪）的密度（2026-10-25 异羽：“碎片吹散的时候感觉不太像雪，是不是太少了，加一倍”）。
 *  每个字切成 rows × cols 格、只留有笔画的那些格，所以 5×5 → 7×7 的数量比是 49/25 ≈ 1.96
 *  —— 正好“加一倍”，且每片更小（雪粒而不是纸片）。
 *  fineP 是「细屑」的抽样率：每一天有墨的格子再按这个概率冒一粒小点。
 *  2026-10-25 格数翻倍时没动它（当时已随之翻倍）；2026-10-27 异羽看着雪感不够，单独提到 **0.30**。
 *  这个数直接决定“雪”的密度，且**不影响主碎片的尺寸**；想加雪只动它。
 *  再不够就像沙尘了，先别超过 0.5。 */
const DENSITY = { rowsBig: 7, rowsSmall: 6, colsBig: 7, colsSmall: 6, fineP: 0.3 };
/** 碎片整体浓度（2026-10-25 异羽：0.24 → 0.3 → **0.36**）。
 *  乘在每片自带的 `alpha0`（0.66~0.98）之上 —— 所以峰值实际落在 0.24~0.35。
 *  与居盈两侧（ghost 灰 + 0.36）对齐：两边现在同一个浓度，碎片只是多了寿命衰减。
 *  颜色不在这里定：由调用方传 `shardColor`（见 lyric-strip.js 的 ghostRgb）。 */
const SHARD_OPACITY = 0.36;

const probe = document.createElement("canvas").getContext("2d");

/** 碎片边长按字号取：字越小格越细，落下来的才是「屑」而不是砖。 */
function cellFor(fontPx) {
  return Math.max(3, Math.min(10, Math.round(fontPx / 2.7)));
}

function measure(value, font) {
  probe.font = font;
  return probe.measureText(value).width;
}

/** 从尾部去字、补省略号，直到整句塞得进去。 */
function fitValue(value, font, avail, padX) {
  const body = String(value || "");
  if (measure(body, font) + padX * 2 <= avail) return body;
  const chars = Array.from(body);
  while (chars.length > 1) {
    chars.pop();
    const next = chars.join("") + "…";
    if (measure(next, font) + padX * 2 <= avail) return next;
  }
  return chars.join("") + "…";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function createShatterField(canvas) {
  const ctx = canvas.getContext("2d");
  let dpr = 1;
  let cssW = 1;
  let cssH = 1;

  let fontPx = 20;
  let family = "serif";
  let color = "#7a8b93";
  /** 碎片的颜色（空 = 跟整句同色）。2026-10-25 异羽要求碎片改用居盈两侧那层灰。 */
  let shardColor = "";

  let text = "";
  let bake = null;
  let appearAt = 0;
  let clock = 0;
  let parts = [];
  /** 0..1：句子快唱完时整句先「吸气」放大，爆开那一刻正好到顶。由外面推。 */
  let emphasis = 0;

  /* ---------------- 尺寸 ---------------- */

  /** 跟随 CSS 尺寸与 DPR 重设位图。返回 true 表示重建过（要重烘字）。 */
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const ratio = Math.min(MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    const pixelW = Math.max(1, Math.round(w * ratio));
    const pixelH = Math.max(1, Math.round(h * ratio));
    const changed = pixelW !== canvas.width || pixelH !== canvas.height;
    cssW = w;
    cssH = h;
    if (!changed) {
      dpr = ratio;
      return false;
    }
    dpr = ratio;
    canvas.width = pixelW;
    canvas.height = pixelH;
    return true;
  }

  /* ---------------- 烘焙一行字 ---------------- */

  function bakeLine(value) {
    const body = String(value || "");
    const font = `600 ${fontPx}px ${family}`;
    const lineH = Math.ceil(fontPx * 1.4);
    const padX = Math.max(4, Math.round(fontPx * 0.3));
    const avail = Math.max(24, cssW - 16);
    const natural = measure(body, font) + padX * 2;
    const rawScale = avail / Math.max(1, natural);
    const scale = clamp(rawScale, MIN_SCALE, 1);
    const shown = rawScale < MIN_SCALE ? fitValue(body, font, avail / scale, padX) : body;
    const wCss = Math.max(1, (measure(shown, font) + padX * 2) * scale);
    const hCss = Math.max(1, lineH * scale);

    const surface = document.createElement("canvas");
    surface.width = Math.max(1, Math.round(wCss * dpr));
    surface.height = Math.max(1, Math.round(hCss * dpr));
    const sctx = surface.getContext("2d");
    sctx.scale(dpr * scale, dpr * scale);
    sctx.font = font;
    sctx.fillStyle = color;
    sctx.textAlign = "left";
    sctx.textBaseline = "middle";
    sctx.fillText(shown, padX, lineH / 2);

    /* 碎片单独一张图：整句与碎片本来同源（同一张烘图），要分开颜色就必须多烘一张。
       两张只有 fillStyle 不同，字形、字号、坐标完全一致，所以 srcX/srcY/srcW/srcH 可以共用；
       alpha 检测也仍用第一张（字形相同，透明度通道一样）。 */
    let shardSurface = surface;
    if (shardColor && shardColor !== color) {
      shardSurface = document.createElement("canvas");
      shardSurface.width = surface.width;
      shardSurface.height = surface.height;
      const cctx = shardSurface.getContext("2d");
      cctx.scale(dpr * scale, dpr * scale);
      cctx.font = font;
      cctx.fillStyle = shardColor;
      cctx.textAlign = "left";
      cctx.textBaseline = "middle";
      cctx.fillText(shown, padX, lineH / 2);
    }

    let alphaMap = null;
    try {
      alphaMap = sctx.getImageData(0, 0, surface.width, surface.height).data;
    } catch {
      // 读不到像素（极少见）就退回整格全收，碎片会多一点方块感
      alphaMap = null;
    }

    // 每个字的横向范围（CSS px，相对这张图）：碎片按字切，不用一张统一的网格，
    // 不然一个字的笔画会被切到隔壁字的块里，碎开时看着像「整句变噪点」。
    const glyphs = [];
    let cursor = padX;
    for (const ch of Array.from(shown)) {
      const cw = measure(ch, font);
      glyphs.push({ x: cursor * scale, w: Math.max(1, cw * scale) });
      cursor += cw;
    }

    return {
      canvas: surface,
      /** 碎片从这张图上取像素（没另配颜色时就是 canvas 本身）。 */
      shardCanvas: shardSurface,
      alpha: alphaMap,
      w: wCss,
      h: hCss,
      glyphs,
      cell: cellFor(fontPx),
    };
  }

  function retexture() {
    bake = text ? bakeLine(text) : null;
    // 新句晚 0.1 秒浮现：旧句炸开的那一下得有自己的空间，不然两句话挤在同一帧里。
    appearAt = clock + 0.1;
    emphasis = 0;
    if (!text) parts = [];
  }

  /** 整句当前的放大倍数：1 = 原大，最多 1.2（长句按可用宽度封顶，免得溢出面板）。 */
  function emphasisScale() {
    if (!bake) return 1;
    const max = Math.min(1.2, Math.max(1, (cssW - 8) / bake.w));
    return 1 + (max - 1) * emphasis;
  }

  /** 推吸气量（0..1）。调用方在句子最后几百毫秒里把它推到 1。 */
  function setEmphasis(value) {
    emphasis = clamp(Number(value) || 0, 0, 1);
  }

  /* ---------------- 对外：配置 ---------------- */

  function configure(next) {
    if (!next) return;
    let dirty = false;
    const px = Number(next.font);
    if (Number.isFinite(px) && px > 0 && px !== fontPx) {
      fontPx = px;
      dirty = true;
    }
    if (next.family && next.family !== family) {
      family = String(next.family);
      dirty = true;
    }
    if (next.color && next.color !== color) {
      color = String(next.color);
      dirty = true;
    }
    if (next.shardColor !== undefined && String(next.shardColor || "") !== shardColor) {
      shardColor = String(next.shardColor || "");
      dirty = true;
    }
    // 碎屑在飞的时候不重烘（会跳），等这一阵落完再说
    if (dirty && !parts.length) retexture();
  }

  /** 换一句要显示的字。空串 = 什么都不显示。 */
  function setText(value) {
    const next = String(value || "");
    if (next === text) return;
    text = next;
    retexture();
  }

  /* ---------------- 爆开 ---------------- */

  function burst() {
    if (!bake || !bake.alpha) {
      bake = null;
      text = "";
      return;
    }
    const img = bake.alpha;
    /* 碎片从 shardCanvas 取像素（与整句同字形、不同颜色）；没另配就退回整句那张。 */
    const shardSrc = bake.shardCanvas || bake.canvas;
    const width = bake.canvas.width;
    const swell = emphasisScale();
    const centerX = cssW / 2;
    const centerY = cssH / 2;
    const rows = fontPx >= 26 ? DENSITY.rowsBig : DENSITY.rowsSmall;
    const glyphs = bake.glyphs && bake.glyphs.length ? bake.glyphs : [{ x: 0, w: bake.w }];
    // 一阵风只有一个方向：整句共用。每片在它周围抖 ±35%，所以看上去是「被吹走」
    // 而不是「原地炸开」。（逐片各自随机方向会变成一团噪点，没有风的意象。）
    const windDir = Math.random() < 0.5 ? -1 : 1;

    for (const glyph of glyphs) {
      // 每字切 cols 列：到这个粒度基本认不出笔画了，是雪粒而不是纸片。
      // 2026-10-25 异羽看过实机后要求“加一倍”（5/4 → 7/6，见顶部 DENSITY）。
      const cols = glyph.w >= 15 ? DENSITY.colsBig : DENSITY.colsSmall;
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const w = glyph.w / cols;
          const h = bake.h / rows;
          const x = glyph.x + w * c;
          const y = h * r;
          if (w < 1 || h < 1) continue;
          if (!hasInk(img, width, x, y, w, h, dpr)) continue;

          const sx = x * dpr;
          const sy = y * dpr;
          const sw = Math.max(1, w * dpr);
          const sh = Math.max(1, h * dpr);
          if (sx + sw > bake.canvas.width || sy + sh > bake.canvas.height) continue;

          // 碎片的位置从**膨胀后**的字上取，尺寸不跟着放大：雪粒应该小（用户 2026-10-20 定的）。
          const px = centerX + (x + w / 2 - bake.w / 2) * swell;
          const py = centerY + (y + h / 2 - bake.h / 2) * swell;
          const dx = px - centerX;
          const dy = py - centerY;
          // 「风一吹就散」：主导方向是**横向**。面板是扁长条，宽几百像素、高只有几十，
          // 往下落的可见行程太短；横向反而不受限，所以碎片是被吹着走的，只是顺便往下沉一点。
          const windDirInner = Math.random() < 0.16 ? -windDir : windDir;
          const gust = 105 + Math.random() * 135;
          parts.push({
            src: shardSrc,
            srcX: sx,
            srcY: sy,
            srcW: sw,
            srcH: sh,
            x: px,
            y: py,
            w,
            h,
            vx: windDirInner * gust * (0.55 + Math.random() * 0.9),
            vy: (Math.random() - 0.44) * 34 + dy * 0.12,
            rot: 0,
            vr: (Math.random() - 0.5) * 4.2,
            g: 26 + Math.random() * 48,
            drag: 0.5 + Math.random() * 0.55,
            sway: 10 + Math.random() * 20,
            swayFreq: 0.8 + Math.random() * 1.8,
            swayPhase: Math.random() * Math.PI * 2,
            ttl: 1.9 + Math.random() * 1.3,
            life: 0,
            delay: Math.random() * 0.035,
            alpha0: 0.66 + Math.random() * 0.32,
          });

          // 隔一块抽一小撮细屑出来：大块是「碎片」，这些小点才是「雪」。
          if (Math.random() < DENSITY.fineP) {
            const fw = Math.max(1.2, Math.min(2, w * 0.36));
            const fh = Math.max(1.2, Math.min(2, h * 0.28));
            const fx = x + Math.random() * Math.max(0.1, w - fw);
            const fy = y + Math.random() * Math.max(0.1, h - fh);
            if (hasInk(img, width, fx, fy, fw, fh, dpr)) {
              parts.push({
                src: shardSrc,
                srcX: fx * dpr,
                srcY: fy * dpr,
                srcW: Math.max(1, fw * dpr),
                srcH: Math.max(1, fh * dpr),
                x: centerX + (fx + fw / 2 - bake.w / 2) * swell,
                y: centerY + (fy + fh / 2 - bake.h / 2) * swell,
                w: fw,
                h: fh,
                vx: windDirInner * (40 + Math.random() * 110),
                vy: (Math.random() - 0.4) * 16,
                rot: 0,
                vr: (Math.random() - 0.5) * 6,
                g: 16 + Math.random() * 26,
                drag: 0.2 + Math.random() * 0.35,
                sway: 22 + Math.random() * 28,
                swayFreq: 1.0 + Math.random() * 1.6,
                swayPhase: Math.random() * Math.PI * 2,
                ttl: 2.3 + Math.random() * 1.3,
                life: 0,
                delay: Math.random() * 0.16,
                alpha0: 0.5 + Math.random() * 0.28,
              });
            }
          }
        }
      }
    }
    bake = null;
    text = "";
  }

  /** 这一格里有笔画吗（隔像素抽样，够用且不慢）。 */
  function hasInk(data, strideWidth, x, y, w, h, ratio) {
    const x0 = Math.max(0, Math.floor(x * ratio));
    const y0 = Math.max(0, Math.floor(y * ratio));
    const x1 = Math.min(strideWidth, Math.ceil((x + w) * ratio));
    const total = data.length / 4;
    const rows = Math.floor(total / strideWidth);
    const y1 = Math.min(rows, Math.ceil((y + h) * ratio));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        if (data[(py * strideWidth + px) * 4 + 3] > 26) return true;
      }
    }
    return false;
  }

  /* ---------------- 推进与绘制 ---------------- */

  function tick(dt) {
    const step = clamp(Number(dt) || 0, 0, 0.05);
    clock += step;
    if (!parts.length) return;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const p = parts[i];
      p.life += step;
      if (p.life >= p.ttl) {
        parts.splice(i, 1);
        continue;
      }
      if (p.life < p.delay) continue;
      p.vy += p.g * step;
      p.vx *= Math.max(0, 1 - p.drag * step);
      p.vy *= Math.max(0, 1 - p.drag * 0.8 * step);
      // 风力推着走，湍流撮在**垂直**方向：碎片是被吹得忽上忽下，不是左右拐。
      p.x += p.vx * step;
      p.y += (p.vy + Math.sin(p.life * p.swayFreq + p.swayPhase) * p.sway) * step;
      p.rot += p.vr * step;
      if (p.y - p.h > cssH + 30 || p.x < -40 || p.x > cssW + 40) parts.splice(i, 1);
    }
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);

    // 屑在字的**下面**：新的一句已经浮现，旧句的碎渣从它背后吹过去，不挡阅读。
    for (const p of parts) {
      const ratio = p.life / p.ttl;
      // 前段慢、后段快：前一半时间里几乎不掉，尾巴上才一下收完。
      // 指数 < 1 就是这个形状（指数 > 1 会反过来：一出来就淡、最后拖一条长尾）。
      const alpha = SHARD_OPACITY * p.alpha0 * Math.pow(1 - ratio, 0.6);
      if (alpha <= 0.012) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      // 越接近寿命末端缩得越小：空间只有一行高，靠「缩小 + 淡出」把消散交代完。
      const shrink = 1 - 0.16 * ratio * ratio;
      ctx.scale(shrink, shrink);
      ctx.drawImage(p.src, p.srcX, p.srcY, p.srcW, p.srcH, -p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }

    if (bake) {
      const age = clock - appearAt;
      const fade = clamp(age / 0.16, 0, 1);
      const lift = (1 - fade) * 3;
      const swell = emphasisScale();
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(cssW / 2, cssH / 2 + lift);
      ctx.scale(swell, swell);
      ctx.drawImage(bake.canvas, -bake.w / 2, -bake.h / 2, bake.w, bake.h);
      ctx.restore();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** 换歌 / 换模式 / 没词：把字与在飞的屑一起撤掉。 */
  function reset() {
    text = "";
    bake = null;
    parts = [];
    appearAt = clock;
  }

  return {
    configure,
    setText,
    setEmphasis,
    burst,
    tick,
    draw,
    reset,
    resize,
    get size() {
      return { w: cssW, h: cssH, dpr };
    },
    get busy() {
      return parts.length > 0;
    },
    get text() {
      return text;
    },
  };
}
