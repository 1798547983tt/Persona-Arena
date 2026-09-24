import { JSON_ONLY_RULE } from './llm.js';
// 提示词：性格预设、行动/沙龙/私语/人设生成的消息构造。

export const PERSONALITY_PRESETS = Object.freeze([
    { id: 'loyal', name: '忠犬', text: '重情、认死理、护短。一旦认了主或认了朋友，就把对方的事当自己的事。不擅长撒谎，也不会背叛。', bottomLines: '不背叛自己认定的人；不伤害无辜。' },
    { id: 'cold', name: '冷面刀客', text: '话少、眼毒、动作快。凡事先算代价，情绪只在极少的瞬间外露。尊重强者，蔑视废话。', bottomLines: '不做无意义的杀戮；不欠人情。' },
    { id: 'manic', name: '疯批', text: '情绪像潮水，可以前一秒温柔后一秒失控。有自己的一套逻辑，执念极深，爱憎都走极端。', bottomLines: '不允许任何人碰自己的执念对象。' },
    { id: 'mild', name: '温吞老好人', text: '慢半拍，凡事往好处想，先照顾别人再想自己。容易被拿捏，但被逼到墙角会用最笨的方式硬顶。', bottomLines: '不对老弱动手；不说恶毒的话。' },
    { id: 'tsundere', name: '傲娇', text: '嘴硬心软，关心人的方式是挖苦。越在乎越别扭，被戳穿时会炸毛。', bottomLines: '绝不承认自己在乎；不当众哭。' },
    { id: 'schemer', name: '算计者', text: '每一句话都有目的，善于布局与借刀。笑容是工具，感情是筹码，但也会为真正稀有的东西破例。', bottomLines: '不做没有退路的赌局；不把底牌给任何人。' },
    { id: 'idealist', name: '理想主义者', text: '相信秩序、正义或某种更高的东西，愿意为之付出代价。天真但不蠢，被现实打击后会更固执。', bottomLines: '不违背自己的信条，哪怕吃亏。' },
    { id: 'chaos', name: '乐子人', text: '哪里热闹去哪里，最怕无聊。爱看戏也爱下场搅局，嘴上没把门，但有自己的分寸。', bottomLines: '玩笑不开到人命上；不出卖一起玩的人。' },
    { id: 'mercenary', name: '唯利是图', text: '一切明码标价，交情也能换钱。专业、守约、不多问，但价格合适什么都做，价格不合适什么都不做。', bottomLines: '收了钱一定办事；不接亏本的单。' },
    { id: 'saint', name: '圣母', text: '见不得人受苦，能救就救，哪怕对方是敌人。温柔、固执、偶尔天真得让人火大。', bottomLines: '不杀人；不见死不救。' },
]);

export function presetById(id) {
    return PERSONALITY_PRESETS.find(p => p.id === id) || null;
}

export const ORIGIN_LABELS = Object.freeze({
    original: '原创',
    story: '故事中人',
    crossover: '魂穿 · 同人',
});

function sheetText(actor, state = null) {
    const s = actor.sheet || {};
    const preset = presetById(s.presetId);
    const lines = [];
    lines.push(`姓名：${actor.name}`);
    if (s.origin === 'crossover' && s.source) lines.push(`来历：来自《${s.source}》，以本来的人格与记忆进入这个故事（魂穿/身穿）。`);
    else if (s.origin === 'story') lines.push('来历：本就是这个故事里的人物。');
    else lines.push('来历：原创人物。');
    if (preset) lines.push(`性格底色（${preset.name}）：${preset.text}`);
    if (s.personality) lines.push(`性格：${s.personality}`);
    if (s.appearance) lines.push(`外貌：${s.appearance}`);
    if (s.backstory) lines.push(`经历：${s.backstory}`);
    if (s.voice) lines.push(`口吻与习惯：${s.voice}`);
    const bottom = [s.bottomLines, preset && !s.bottomLines ? preset.bottomLines : ''].filter(Boolean).join(' ');
    if (bottom) lines.push(`底线（绝不做的事）：${bottom}`);
    if (s.goals) lines.push(`长期目标：${s.goals}`);
    const abilities = abilitiesText(actor, state);
    if (abilities) lines.push(`能力：${abilities}`);
    const overlay = overlayText(state);
    if (overlay) lines.push(`【本剧中已发生的变化（以此为准，覆盖上文冲突之处）】\n${overlay}`);
    return lines.join('\n');
}

const OVERLAY_LABELS = { personality: '性格', appearance: '外貌', backstory: '经历', voice: '口吻', bottomLines: '底线', goals: '目标' };

export function overlayText(state) {
    const o = state?.overlay || {};
    return Object.entries(OVERLAY_LABELS)
        .filter(([k]) => String(o[k] || '').trim())
        .map(([k, label]) => `- ${label}：${String(o[k]).trim()}`)
        .join('\n');
}

export function abilitiesText(actor, state) {
    const base = String(actor?.sheet?.abilities || '').split(/\n|；|;/).map(x => x.trim()).filter(Boolean);
    const dyn = (state?.abilities || []).map(a => a.note ? `${a.name}（${a.note}）` : a.name);
    const all = [...base, ...dyn];
    return all.length ? all.join('、') : '';
}

function bondsText(state, threshold) {
    if (!state?.bonds?.length) return '（还没有形成明确的关系）';
    return state.bonds
        .slice()
        .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
        .slice(0, 12)
        .map(b => {
            const level = b.score >= threshold ? '【极重要】' : b.score <= -threshold ? '【死敌】' : '';
            return `- ${b.target}：${b.score >= 0 ? '+' : ''}${b.score}${b.label ? '，' + b.label : ''}${b.note ? '（' + b.note + '）' : ''} ${level}`.trim();
        })
        .join('\n');
}

function chronicleText(state, n = 8) {
    const list = (state?.chronicle || []).slice(-n);
    if (!list.length) return '（暂无）';
    return list.map(c => `- ${c.round != null ? `回合${c.round}：` : ''}${c.text}`).join('\n');
}

export function panelText(actor, state, threshold = 60) {
    return [
        `当前心情：${state?.mood || '平静'}`,
        `当前目标：${state?.goal || '（尚未决定）'}`,
        `关系（-100 到 100）：\n${bondsText(state, threshold)}`,
        `最近的经历：\n${chronicleText(state)}`,
    ].join('\n');
}

export function stageText(stage, settings) {
    const parts = [];
    if (stage.names?.user || stage.names?.char) {
        parts.push(`舞台：玩家叫「${stage.names.user || '用户'}」，对手戏角色是「${stage.names.char || '（群聊）'}」。`);
    }
    if (settings.includeCharacterCard && stage.cardSummary) {
        parts.push(`【舞台设定摘要】\n${stage.cardSummary}`);
    }
    if (settings.includeWorldInfo && stage.loreText) {
        parts.push(`【此刻触发的世界书】\n${stage.loreText}`);
    }
    const floors = (stage.floors || []).map(f => `${f.name}：${f.text}`).join('\n\n');
    parts.push(`【舞台最近 ${stage.floors?.length || 0} 层】\n${floors || '（舞台上还没有任何内容）'}`);
    return parts.join('\n\n');
}

const MOVE_RULES = `你是一名演员，正在一场多人即兴剧里扮演上面这个人物。剧本由旁白（另一个 AI）推进；你不是旁白。

铁律：
1. 只输出「${'{{name}}'}」本人此刻的行动：动作、话语、神态、内心一闪而过的念头。
2. 不描写其他任何人的反应、表情或台词；不替旁白推进时间、环境、剧情；不总结、不点评、不解释。
3. 不写"于是""接着发生了"这类叙事推进；一段结束在你自己身上。
4. 以剧本里"一个人的一次登场"为尺度：一到三个动作，一两句话，长度不超过 {{max}} 字。
5. 用中文，第三人称（用名字）或第一人称皆可，但视角只在你自己身上。
6. 忠于人设与关系表：面对【极重要】的人，你的选择会被这段关系左右；面对【死敌】亦然。
7. 若面板里有「已接受的玩家指令」，把它当作你此刻的私下动机去执行，但用你自己的方式，不生硬。

输出格式（严格）：
<move>
这里是行动正文
</move>
<state>
{"mood":"一句话心情","goal":"一句话当前目标","bonds":[{"target":"对象名","delta":-5,"label":"关系标签","note":"一句备注"}],"memory":"这一回合值得记住的一句话"}
</state>
bonds 只写这一回合有变化的对象；没有变化就给空数组。<state> 里必须是合法 JSON。`;

export function buildMoveMessages({ actor, state, stage, priorMoves, settings, salonDigest, pendingInstruction, plotFeed }) {
    const threshold = settings.bondImportantThreshold ?? 60;
    const sys = actor.promptOverride?.trim()
        ? actor.promptOverride.replace(/\{\{name\}\}/g, actor.name).replace(/\{\{max\}\}/g, String(settings.moveMaxChars))
        : [
            `【人设卡】\n${sheetText(actor, state)}`,
            `【面板】\n${panelText(actor, state, threshold)}`,
            pendingInstruction ? `【已接受的玩家指令】\n${pendingInstruction}` : '',
            MOVE_RULES.replace(/\{\{name\}\}/g, actor.name).replace(/\{\{max\}\}/g, String(settings.moveMaxChars)),
        ].filter(Boolean).join('\n\n');

    const userParts = [stageText(stage, settings)];
    if (plotFeed) {
        userParts.push(`【剧情走向（导演的意图，仅供你把握分寸；不要在行动里点明或复述）】\n${plotFeed}`);
    }
    if (settings.includeSalonDigest && salonDigest) {
        userParts.push(`【幕后沙龙里大家最近说的话（故事外，仅供参考，不要在行动里提及）】\n${salonDigest}`);
    }
    if (priorMoves?.length) {
        userParts.push(`【本回合已经出手的演员】\n${priorMoves.map(m => `${m.name}：${m.text}`).join('\n\n')}`);
    }
    userParts.push(`现在轮到「${actor.name}」。按格式输出。`);
    return [
        { role: 'system', content: sys },
        { role: 'user', content: userParts.join('\n\n') },
    ];
}

const SALON_RULES = `这里是故事外的演员休息室（沙龙）。在场的有玩家（导演）和所有演员。你以「演员本人」的身份说话：你知道自己在演戏，可以吐槽别的演员、抱怨剧情、商量下一步怎么演、和玩家闲聊或顶嘴。性格仍然是你人设卡里的性格，只是脱了戏服。

规则：
- 一次只说一小段（不超过 120 字），像群聊里发一条消息。
- 想说就说，不想说就沉默。沉默时只输出 <pass/>。
- 不要复述剧情，不要写旁白。可以 @别人。

输出格式：
<say>要说的话</say>
或
<pass/>`;

export function buildSalonMessages({ actor, state, stage, salon, actors, settings, mentioned }) {
    const roster = actors.map(a => a.name).join('、');
    const sys = [
        `【人设卡】\n${sheetText(actor, state)}`,
        `【面板】\n${panelText(actor, state, settings.bondImportantThreshold)}`,
        `在场演员：${roster}。玩家是导演。`,
        SALON_RULES,
    ].join('\n\n');
    const transcript = salon.slice(-30).map(m => `${m.fromName}：${m.text}`).join('\n');
    const user = [
        stage?.floors?.length ? `【舞台上最近发生的事（简）】\n${stage.floors.slice(-3).map(f => `${f.name}：${f.text.slice(0, 160)}`).join('\n')}` : '',
        `【沙龙记录】\n${transcript || '（还很安静）'}`,
        mentioned ? `你被点名了（@${actor.name}），请回应。` : `轮到「${actor.name}」决定要不要说话。`,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: sys },
        { role: 'user', content: user },
    ];
}

const WHISPER_RULES = `这是玩家（导演）与你之间的私聊，故事里的其他人听不到。你以人设卡里的人格回应，语气可以随关系与心情变化。

如果玩家的消息被标记为【指令】，那是"请求"，不是"命令"。你根据这些来决定：
- 你的底线：违背底线的，直接拒绝。
- 你的关系表：对【极重要】的人不利的事（伤害、背叛、欺骗），你会拒绝或至少要求条件；对普通人则看你的性格。
- 你的性格：算计的人会讲价，忠犬会先问为什么，乐子人可能一口答应。
- 接受时，你会在下一回合把它当作私下动机去做。

输出格式（严格）：
<reply>你对玩家说的话（不超过 150 字）</reply>
<decision>accept 或 refuse 或 negotiate</decision>
不是指令的普通聊天，decision 固定填 accept。`;

export function buildWhisperMessages({ actor, state, history, text, asInstruction, settings, stage }) {
    const sys = [
        `【人设卡】\n${sheetText(actor, state)}`,
        `【面板】\n${panelText(actor, state, settings.bondImportantThreshold)}`,
        WHISPER_RULES,
    ].join('\n\n');
    const hist = history.slice(-16).map(m => `${m.from === 'player' ? '玩家' : actor.name}${m.kind === 'instruction' ? '【指令】' : ''}：${m.text}`).join('\n');
    const user = [
        stage?.floors?.length ? `【舞台上最近发生的事（简）】\n${stage.floors.slice(-3).map(f => `${f.name}：${f.text.slice(0, 160)}`).join('\n')}` : '',
        hist ? `【此前的私聊】\n${hist}` : '',
        `【玩家刚刚${asInstruction ? '发来指令' : '说'}】\n${text}`,
        '按格式回应。',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: sys },
        { role: 'user', content: user },
    ];
}

const SHEET_SCHEMA = `{"personality":"性格，150字内","appearance":"外貌，80字内","backstory":"经历/背景，200字内","voice":"口吻、口癖、说话习惯，80字内","bottomLines":"绝不做的事，60字内","goals":"长期目标，60字内","emoji":"一个最像TA的emoji"}`;

export function buildSheetGenerationMessages({ name, source, hints, searchDigest, origin }) {
    const sys = `你是资深的角色设定编辑。根据给定信息，写出一份可直接用于即兴剧演员的人设卡。要求：准确（有原作就忠于原作）、具体（可演出来的细节，而非空洞形容词）、有棱角（写出矛盾与底线）。只输出一个 JSON 对象，不要前后缀、不要代码块。字段：${SHEET_SCHEMA}\n${JSON_ONLY_RULE}`;
    const user = [
        `人物：${name}`,
        origin === 'crossover' && source ? `来源作品：《${source}》。这个人物会以原本的人格与记忆进入另一个故事（魂穿/身穿），人设卡要写清 TA 原本是谁、有什么执念与习惯。` : '',
        hints ? `额外要求：${hints}` : '',
        searchDigest ? `【联网搜索到的资料】\n${searchDigest}` : '',
        '输出 JSON。',
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: sys },
        { role: 'user', content: user },
    ];
}

export function buildNpcExtractionMessages({ npcName, stage }) {
    const sys = `你是资深的角色设定编辑。从舞台记录与世界书中提炼名叫「${npcName}」的人物，写成一份即兴剧演员可用的人设卡。没有的信息可以基于已有线索合理补全，但不要与记录冲突。只输出一个 JSON 对象，不要代码块。字段：${SHEET_SCHEMA}\n${JSON_ONLY_RULE}`;
    const user = [
        stage.loreText ? `【世界书】\n${stage.loreText}` : '',
        `【舞台记录】\n${(stage.floors || []).map(f => `${f.name}：${f.text}`).join('\n\n')}`,
        `提炼「${npcName}」。输出 JSON。`,
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: sys },
        { role: 'user', content: user },
    ];
}

export function buildSalonDigest(salon, n = 8) {
    const list = (salon || []).slice(-n);
    if (!list.length) return '';
    return list.map(m => `${m.fromName}：${m.text}`).join('\n');
}


// ---------- 剧情罗盘 ----------

export function buildChunkSummaryMessages({ name, index, total, chunk, prevSummary }) {
    const sys = `你是小说编辑，正在为《${name}》做逐段剧情提要，供后续汇总成"原著梗概"。要求：只写这一段里发生的事实——人物、事件、因果、关系变化、埋下的伏笔、揭示的设定；按发生顺序写；不评论、不抒情；300 到 500 字；用中文。`;
    const user = [
        prevSummary ? `【上一段的提要（仅供衔接，不要重复）】\n${prevSummary}` : '',
        `【第 ${index}/${total} 段原文】\n${chunk}`,
        '写这一段的提要。',
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

export function buildDigestMessages({ name, summaries, maxChars }) {
    const sys = `你是小说编辑，要把《${name}》的逐段提要汇总成一份"原著梗概"，供另一个 AI 判断故事走向用。用 Markdown，严格按以下小节输出，总长不超过 ${maxChars} 字：
## 一句话概括
## 主线梗概（按时间顺序，分阶段）
## 主要人物（名字：身份、动机、与他人的关系、结局或去向）
## 关键转折点（编号，每条一句：事件 → 后果）
## 世界规则与设定（力量体系、势力、地理、禁忌）
## 伏笔与未解之谜
## 原著的必然逻辑（哪些事在原著逻辑下"必然"发生，为什么）
只写原著里有的事实，不臆造。`;
    const user = `【逐段提要】\n${summaries}\n\n输出梗概。`;
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

export function buildMergeSummariesMessages({ name, part, total, summaries }) {
    const sys = `你是小说编辑。把《${name}》第 ${part}/${total} 批逐段提要压缩成一份连贯的阶段提要：保留全部人物、事件、因果与伏笔，去掉重复与废话，按时间顺序，不超过 1200 字。`;
    return [{ role: 'system', content: sys }, { role: 'user', content: summaries }];
}

export const COMPASS_SCHEMA_TEXT = `{"now":"当前局势，2-3句","position":"对应原著进度或章节；没有原著则写\"无原著，自由剧情\"","inevitable":["在现有逻辑下必然会发生的事（写清为什么必然）"],"deviated":[{"what":"已脱离原著之处","cause":"因为什么改变","consequence":"由此带来的后果"}],"impossible":["原著里有、但现在已不可能再发生的事（写原因）"],"possible":[{"what":"可能发生的事","chance":"高|中|低","trigger":"触发条件"}],"butterflies":[{"origin":"起点：一件看似很小的变化","chain":["连锁反应1","连锁反应2"],"outcome":"最终影响"}],"beats":["接下来第一个节拍","第二个节拍","第三个节拍"],"guidance":"给正文 AI 的引导：3-5 句，说明该把故事往哪推、哪些事该自然发生、哪些不要写、节奏如何"}`;

export function buildCompassMessages({ canonName, canonDigest, loreText, stage, notes, previous, actorsBrief, npcsBrief }) {
    const sys = `你是这部互动故事的剧情顾问（不是作者）。你的工作是根据原著梗概、世界设定、故事至今的记录与导演备注，推演剧情走向：什么必然发生、什么已经脱离原著、什么已不可能、什么可能、以及蝴蝶效应。判断要严谨：
- "必然"只写因果链已经闭合、除非外力否则一定发生的事；
- "脱离原著"要指出是哪个变化造成的、后果是什么；
- "不可能"要说明原著里的前提在这里为何已不成立；
- 蝴蝶效应从一件已经发生的小事出发，写清连锁；
- 这是同人向的推演：canonAhead 列出原著时间线上接下来本该发生的事与登场人物，并标注在当前局面下是如期、提前、推迟、已不可能还是已变形；oocRisks 指出原著人物在此处最容易写偏的性格/口吻/立场；
- 引导（guidance）写给正文 AI 看：具体、可执行、不剧透式地点明，尊重人物动机与已成立的事实。
${canonDigest ? '有原著时，以原著逻辑为基准；' : '没有原著时，以故事内已成立的事实、人物动机与世界规则为基准；'}导演备注优先级最高。
只输出一个 JSON 对象（不要代码块、不要前后缀），字段与含义：${COMPASS_SCHEMA_TEXT}
所有值用中文。
${JSON_ONLY_RULE}`;
    const user = [
        canonDigest ? `【原著梗概：《${canonName || '原著'}》】\n${canonDigest}` : '【原著】无。这是自由剧情。',
        loreText ? `【世界书 / 设定】\n${loreText}` : '',
        actorsBrief ? `【竞技场演员（插件控制的角色）】\n${actorsBrief}` : '',
        npcsBrief ? `【已登场的其他人物】\n${npcsBrief}` : '',
        `【故事至今（最近记录）】\n${(stage.floors || []).map(f => `${f.name}：${f.text}`).join('\n\n') || '（故事尚未开始）'}`,
        previous ? `【上一次的推演（供对照，指出哪些已实现、哪些需修正）】\n${previous}` : '',
        notes ? `【导演备注（最高优先级）】\n${notes}` : '',
        '输出 JSON。',
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

// ---------- 史官 ----------

export const CHRONICLER_SCHEMA_TEXT = `{"summary":"这一楼发生了什么，一句话","actors":[{"name":"演员名（必须与给定名字完全一致）","mood":"一句话心情（无变化留空）","goal":"一句话目标（无变化留空）","memory":"值得记进经历簿的一句（无则留空）","bonds":[{"target":"对象名","delta":-5,"label":"关系标签","note":"一句备注"}],"abilities":{"gained":[{"name":"新获得的能力/物品/身份","note":"说明"}],"changed":[{"name":"已有能力","note":"变化"}],"lost":["失去的能力"]},"sheet":{"personality":"性格上的新变化，一句（无则留空）","appearance":"外貌变化（伤疤、装束等）","backstory":"新增的经历一句","voice":"口吻变化","goals":"长期目标变化"}}],"npcs":[{"name":"这一楼出现的非演员人物","role":"身份","note":"一句备注"}]}`;

export function buildChroniclerMessages({ actors, npcs, floors, floor, prior, fields, plotBeats }) {
    const batch = Array.isArray(floors) && floors.length ? floors : (floor ? [floor] : []);
    const enabled = Object.entries(fields || {}).filter(([, v]) => v).map(([k]) => k);
    const sys = `你是这部多人即兴剧的史官。每隔几楼，你核对一次每位演员的人设、面板与关系，只记录**新增楼层里确实发生了的变化**（把这几楼合起来看，一次性给出净变化）：心情、目标、关系（羁绊分值增减）、能力/物品/身份的得失、人设层面的变化（性格转变、外貌改变、新经历、口吻变化）。
纪律：
- 没有变化就不写该演员；没有依据不臆造；羁绊 delta 一次通常在 ±3 到 ±15 之间，重大事件才 ±20 以上；
- 人设变化只写"这一楼新出现的"，用一句话，不复述旧设定；
- 只允许更新这些字段：${enabled.join('、') || '（无）'}；其它字段留空或省略；
- 对象名（bonds.target）用故事里的称呼；演员名必须与给定名字完全一致。
只输出一个 JSON 对象（不要代码块），格式：${CHRONICLER_SCHEMA_TEXT}
${JSON_ONLY_RULE}`;
    const roster = actors.map(({ actor, state }) => `## ${actor.name}\n${sheetText(actor, state)}\n${panelText(actor, state)}`).join('\n\n');
    const user = [
        `【演员名单与当前状态】\n${roster}`,
        npcs?.length ? `【已知的其他人物】\n${npcs.map(n => `- ${n.name}${n.role ? '（' + n.role + '）' : ''}${n.note ? '：' + n.note : ''}`).join('\n')}` : '',
        plotBeats ? `【当前剧情走向（供理解语境）】\n${plotBeats}` : '',
        prior?.length ? `【更早的楼层（语境）】\n${prior.map(f => `${f.name}：${f.text}`).join('\n\n')}` : '',
        `【新增的楼层（按顺序，共 ${batch.length} 楼）】\n${batch.map(f => `${f.name}：${f.text}`).join('\n\n')}`,
        '输出 JSON。',
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}


export function buildCanonFromKnowledgeMessages({ name, hints, sources, maxChars }) {
    const sys = `你是熟悉各类小说、动漫、游戏与影视作品的资深编辑，要为《${name}》写一份"原著梗概"，供另一个 AI 判断同人故事的走向。${sources ? '优先依据给定资料，资料没有的用你自己的知识补全；' : '凭你自己对这部作品的知识撰写；'}拿不准的地方标注"（不确定）"，不要编造。用 Markdown，严格按以下小节输出，总长不超过 ${maxChars} 字：
## 一句话概括
## 主线梗概（按时间顺序，分阶段或分卷）
## 主要人物（名字：身份、性格与口吻特征、动机、与他人的关系、结局或去向）
## 关键转折点（编号，每条一句：事件 → 后果）
## 世界规则与设定（力量体系、势力、地理、禁忌）
## 伏笔与未解之谜
## 原著的必然逻辑（哪些事在原著逻辑下"必然"发生，为什么）
## 同人常见 OOC 点（写这部作品的人物最容易写偏的地方）`;
    const user = [
        `作品：《${name}》`,
        hints ? `补充说明：${hints}` : '',
        sources ? `【资料】\n${sources}` : '',
        '输出梗概。',
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

export function buildCanonCharacterMessages({ name, canonName, digest, hints }) {
    const sys = `你是资深的角色设定编辑。根据《${canonName}》的原著梗概（以及你对这部作品的了解），为人物「${name}」写一份可直接用于即兴剧演员的人设卡：忠于原著，具体到口癖、习惯动作、价值观与底线，写出矛盾与执念；梗概里没写到的细节可凭你对原作的知识补全，但不要与梗概冲突。只输出一个 JSON 对象，不要代码块。字段：${SHEET_SCHEMA}\n${JSON_ONLY_RULE}`;
    const user = [
        `【原著梗概】\n${digest}`,
        hints ? `额外要求：${hints}` : '',
        `写「${name}」的人设卡。输出 JSON。`,
    ].filter(Boolean).join('\n\n');
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}
