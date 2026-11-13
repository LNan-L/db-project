import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_SETTINGS } from '../../src/ai/settings';

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));

vi.mock('../../src/ai/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ai/settings')>();
  return { ...actual, loadAiSettings: () => loadMock() };
});

import { AiPanel } from '../../src/components/AiPanel';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AiPanel', () => {
  it('shows a closable error when settings cannot be read', async () => {
    loadMock.mockRejectedValue(new Error('indexeddb blocked'));
    const onClose = vi.fn();
    render(<AiPanel notes={[]} onClose={onClose} />);

    const panel = await screen.findByTestId('ai-panel-error');
    expect(panel).toHaveTextContent('读取 AI 设置失败');
    fireEvent.click(screen.getByTestId('close-ai'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a relative service address on save', async () => {
    loadMock.mockResolvedValue({ ...DEFAULT_AI_SETTINGS });
    render(<AiPanel notes={[]} onClose={() => undefined} />);

    const input = await screen.findByTestId('ai-chat-base-url');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId('ai-save'));
    expect(screen.getByTestId('ai-message')).toHaveTextContent('服务地址无效');
  });

  it('keeps the rebuild button disabled until AI is enabled', async () => {
    loadMock.mockResolvedValue({ ...DEFAULT_AI_SETTINGS });
    render(<AiPanel notes={[]} onClose={() => undefined} />);

    const rebuild = await screen.findByTestId('ai-rebuild-vector');
    expect(rebuild).toBeDisabled();
    fireEvent.click(screen.getByTestId('ai-enabled'));
    expect(screen.getByTestId('ai-rebuild-vector')).toBeEnabled();
  });

  it('blocks an unauthorized remote address before any request', async () => {
    loadMock.mockResolvedValue({ ...DEFAULT_AI_SETTINGS });
    render(<AiPanel notes={[]} onClose={() => undefined} />);

    await screen.findByTestId('ai-chat-base-url');
    fireEvent.change(screen.getByTestId('ai-chat-base-url'), {
      target: { value: 'http://ai.example.com/v1' }
    });
    fireEvent.click(screen.getByTestId('ai-test-chat'));
    expect(screen.getByTestId('ai-message')).toHaveTextContent('未获授权');
  });
});
