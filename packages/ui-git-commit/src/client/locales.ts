/** `gitCommit` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'gitCommit'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'title': '提交信息',
  'style.complete': '完整',
  'style.concise': '简洁',
  'files.one': '{count} 个暂存文件',
  'files.other': '{count} 个暂存文件',
  'generated.generic': '无历史提交，采用通用风格',
  'status.committed': '已提交 {hash}',
  'status.failed': '提交失败',
  'action.commit': '提交',
  'action.regenerate': '重新生成',
  'action.copy': '复制',
  'action.copied': '已复制',
  'busy.commit': '提交中…',
  'busy.regenerate': '生成中…',
  'busy.generating': '生成中…',
  'error.empty': '提交消息不能为空',
  'placeholder': '提交消息…',
  'fallback.unavailable': '提案内容不可用',
  'fallback.invalid': '提案数据无效',
} as const

/** English dictionary (same key set). */
export const en: Record<GitCommitKey, string> = {
  'title': 'Commit message',
  'style.complete': 'Complete',
  'style.concise': 'Concise',
  'files.one': '{count} staged file',
  'files.other': '{count} staged files',
  'generated.generic': 'No commit history; generic style',
  'status.committed': 'Committed {hash}',
  'status.failed': 'Commit failed',
  'action.commit': 'Commit',
  'action.regenerate': 'Regenerate',
  'action.copy': 'Copy',
  'action.copied': 'Copied',
  'busy.commit': 'Committing…',
  'busy.regenerate': 'Generating…',
  'busy.generating': 'Generating…',
  'error.empty': 'Commit message cannot be empty',
  'placeholder': 'Commit message…',
  'fallback.unavailable': 'Proposal payload unavailable',
  'fallback.invalid': 'Invalid proposal payload',
}

/** Union of this namespace's dictionary keys. */
export type GitCommitKey = keyof typeof zh