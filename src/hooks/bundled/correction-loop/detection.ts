const EXPLICIT_CORRECTION_PREFIX = /^(反馈：|复盘：|纠正：)/iu;

const STRONG_CORRECTION_COMPLAINT_PATTERN =
  /(词不达意|答非所问|没答到点上|没说到点上|没抓住重点|没抓到重点|理解错了|答偏了|说偏了|跑题了|偏题了|没懂我的意思|你没懂我的意思|not what i asked|missed the ask|missed my ask|didn't answer|off[-\s]?target|off[-\s]?topic|too vague|too broad|imprecise)/iu;

const CORRECTION_REDIRECT_PATTERN =
  /(刚才|上一条|上条|前面|那段|这段|上次|你刚才|你上一条|不是让你|我让你|我问的是|我要的是|先别重写|重新答|重答|按这个来|先告诉我你理解的|先说动作|先说范围|先说时间框架|先说输出形状)/iu;

export function isExplicitCorrectionLoopInput(text: string): boolean {
  return EXPLICIT_CORRECTION_PREFIX.test(text.trim());
}

export function looksLikeNaturalCorrectionLoopInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (isExplicitCorrectionLoopInput(trimmed)) {
    return true;
  }
  return (
    STRONG_CORRECTION_COMPLAINT_PATTERN.test(trimmed) && CORRECTION_REDIRECT_PATTERN.test(trimmed)
  );
}

export function isCorrectionLoopInput(text: string): boolean {
  return isExplicitCorrectionLoopInput(text) || looksLikeNaturalCorrectionLoopInput(text);
}
