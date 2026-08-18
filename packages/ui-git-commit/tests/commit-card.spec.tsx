// @vitest-environment jsdom
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { CommitStyle, GitCommitProposalPayload } from '@dsh-community/git-commit/types'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommitCard, type CommitCardInjected } from '../src/client/CommitCard.tsx'
import { en, zh as zhDict } from '../src/client/locales.ts'
import type { GitCommitKey } from '../src/client/locales.ts'

/** Run the locale lookup against the Simplified Chinese dictionary (the product copy). */
function tZh(key: GitCommitKey, params?: Record<string, string | number>): string {
  let template = zhDict[key] ?? key
  if (params !== undefined) {
    for (const [param, replacement] of Object.entries(params)) {
      template = template.replaceAll(`{${param}}`, String(replacement))
    }
  }
  return template
}

/** Construct a settled tool/result block carrying the supplied meta. */
function settledBlock(meta: unknown, content: string = ''): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 0,
    time: 0,
    callId: 'call-1',
    call: null,
    callTime: null,
    content: [{ type: 'text', text: content }],
    isError: false,
    meta,
  } as unknown as ToolCallBlock
}

/** A running tool-call block (no meta). */
function runningBlock(): ToolCallBlock {
  return {
    kind: 'running',
    seq: 0,
    time: 0,
    callId: 'call-2',
    call: null,
    callTime: null,
    content: [],
    callView: null,
    resultView: null,
    subCalls: [],
  } as unknown as ToolCallBlock
}

/** Find the style-toggle button by its visible label. The toggle button is the
 *  last element in the card that contains the given label as its text. */
function toggleButton(label: string) {
  const matches = screen.getAllByRole('button', { name: label })
  return matches[matches.length - 1]!
}

const validProposal = (overrides: Partial<GitCommitProposalPayload> = {}): GitCommitProposalPayload => ({
  kind: 'proposal',
  proposalId: 'git-commit-deadbeef',
  style: 'complete',
  message: 'fix: subject\n\nbody details',
  stagedFiles: ['src/a.ts', 'src/b.ts'],
  stagedCount: 2,
  unstagedCount: 0,
  repoRoot: '/repo',
  generatedFrom: 'history',
  ...overrides,
})

const noop = (): never => {
  throw new Error('unexpected call')
}

function makeInjected(overrides: Partial<CommitCardInjected> = {}): CommitCardInjected {
  return {
    commit: vi.fn(async () => null),
    regenerate: vi.fn(async () => null),
    ...overrides,
  }
}

afterEach(() => {
  cleanup()
})

/** Cast minimal props to satisfy the composed slot types. */
function renderCard(block: ToolCallBlock, injected: CommitCardInjected) {
  const props = {
    block,
    toolName: 'git_commit_propose',
    callId: 'call-1',
    cwd: '/repo',
    openFile: noop,
    inspect: undefined,
    t: tZh,
    ...injected,
  } as unknown as Parameters<typeof CommitCard>[0]
  const user = userEvent.setup()
  const utils = render(<CommitCard {...props} />)
  return { user, utils }
}

describe('CommitCard (running)', () => {
  it('renders the running summary while the tool call is in flight', () => {
    renderCard(runningBlock(), makeInjected())
    expect(screen.getByText('生成中…')).toBeInTheDocument()
  })
})

describe('CommitCard (settled, invalid meta)', () => {
  it('renders the raw content as a fallback when the meta is not a proposal payload', () => {
    renderCard(settledBlock(null, 'fallback message text'), makeInjected())
    expect(screen.getByText('fallback message text')).toBeInTheDocument()
  })

  it('falls back to the invalid-payload label when the meta is malformed and content is empty', () => {
    renderCard(settledBlock(null), makeInjected())
    expect(screen.getByText('提案数据无效')).toBeInTheDocument()
  })

  it('renders the failure text when the tool result is in error state', () => {
    const block: ToolCallBlock = {
      ...settledBlock(null, 'plain error'),
      isError: true,
    } as ToolCallBlock
    renderCard(block, makeInjected())
    expect(screen.getByText('plain error')).toBeInTheDocument()
  })
})

describe('CommitCard (settled, valid proposal)', () => {
  it('shows the header, textarea seeded with the message, and action buttons', () => {
    const proposal = validProposal()
    renderCard(settledBlock(proposal), makeInjected())
    expect(screen.getByText('提交信息')).toBeInTheDocument()
    expect(screen.getAllByText('完整').length).toBeGreaterThan(0) // badge + toggle button
    expect(screen.getByText('2 个暂存文件')).toBeInTheDocument()
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textbox.value).toBe('fix: subject\n\nbody details')
    expect(screen.getByRole('button', { name: '提交' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重新生成' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '复制' })).toBeInTheDocument()
  })

  it('blocks commit when the textarea is empty', async () => {
    const proposal = validProposal({ message: '' })
    const injected = makeInjected()
    const { user } = renderCard(settledBlock(proposal), injected)
    await user.clear(screen.getByRole('textbox'))
    await user.click(screen.getByRole('button', { name: '提交' }))
    expect(injected.commit).not.toHaveBeenCalled()
    expect(screen.getByText('提交消息不能为空')).toBeInTheDocument()
  })

  it('dispatches the commit command with the edited message', async () => {
    const proposal = validProposal()
    const injected = makeInjected({ commit: vi.fn(async () => null) })
    const { user } = renderCard(settledBlock(proposal), injected)
    await user.clear(screen.getByRole('textbox'))
    await user.type(screen.getByRole('textbox'), 'edited subject')
    await user.click(screen.getByRole('button', { name: '提交' }))
    expect(injected.commit).toHaveBeenCalledWith(proposal.proposalId, 'edited subject')
  })

  it('flips to committed state when the injected commit returns null', async () => {
    const proposal = validProposal()
    const injected = makeInjected({ commit: vi.fn(async () => null) })
    const { user } = renderCard(settledBlock(proposal), injected)
    await user.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByText(/已提交/)).toBeInTheDocument()
  })

  it('shows the failure reason when the injected commit returns a failure line', async () => {
    const proposal = validProposal()
    const injected = makeInjected({ commit: vi.fn(async () => '暂存区已清空') })
    const { user } = renderCard(settledBlock(proposal), injected)
    await user.click(screen.getByRole('button', { name: '提交' }))
    expect(screen.getByText(/提交失败/)).toBeInTheDocument()
    expect(screen.getByText(/暂存区已清空/)).toBeInTheDocument()
  })

  it('dispatches the regenerate command with the current style on the same-style button', async () => {
    const proposal = validProposal({ style: 'concise' })
    const injected = makeInjected({ regenerate: vi.fn(async () => null) })
    const { user } = renderCard(settledBlock(proposal), injected)
    await user.click(screen.getByRole('button', { name: '重新生成' }))
    expect(injected.regenerate).toHaveBeenCalledWith<CommitStyle[]>('concise')
  })

  it('dispatches the regenerate command with the target style on the style toggle', async () => {
    const proposal = validProposal({ style: 'complete' })
    const injected = makeInjected({ regenerate: vi.fn(async () => null) })
    const { user } = renderCard(settledBlock(proposal), injected)
    await user.click(toggleButton('简洁'))
    expect(injected.regenerate).toHaveBeenCalledWith<CommitStyle[]>('concise')
  })
})

it('(smoke) the en dictionary contains the same keys as zh', () => {
  for (const key of Object.keys(zhDict) as GitCommitKey[]) {
    expect(en[key]).toBeTypeOf('string')
  }
})