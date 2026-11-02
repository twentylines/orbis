import { createHash } from 'node:crypto';
import type { PasskeyState } from './passkey.store';

type Account = { id: number; password: string; operator: boolean; totpEnabled: boolean; totpSecret: string | null; salt: string | null };

export function sensitiveAccountBinding(user: Account, state: PasskeyState) {
  const keys = state.users[user.id];
  return createHash('sha256')
    .update(
      JSON.stringify({
        user: [user.id, user.password, user.operator, user.totpEnabled, user.totpSecret, user.salt],
        policy: keys?.totpAfterPasskey ?? null,
        credentials: (keys?.credentials ?? [])
          .map(({ id, publicKey, rpID }) => ({ id, publicKey, rpID }))
          .sort((first, second) => first.id.localeCompare(second.id)),
      }),
    )
    .digest('hex');
}
