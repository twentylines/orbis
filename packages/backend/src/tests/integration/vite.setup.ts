import { vi } from 'vitest';

vi.mock('@/utils/cooldown/cooldown', () => ({
  Cooldown: () => vi.fn().mockImplementation((fn) => fn),
}));
