import { useState } from 'react';
import { Button, Dialog, Input } from '@formai/ui';
import { ApiError } from '../../lib/data/api-client.js';
import { useConfirmPassword } from '../../lib/data/hooks.js';

/**
 * The signing step-up dialog: applying a STORED signature is an act of
 * attestation, so the person proves they are at the keyboard by re-entering
 * their password at that moment. On a 204 the caller writes the saved mark
 * into the field; on anything else the field is untouched. The distinction
 * this protects: a session cookie on a shared site tablet says a session
 * exists, not that its owner is the one signing.
 */
export function ConfirmSignatureDialog({
  open,
  context,
  onClose,
  onConfirmed,
}: {
  open: boolean;
  context: { caseId?: string; attemptId?: string; fieldId?: string };
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const confirm = useConfirmPassword();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setPassword('');
    setError(null);
    onClose();
  };

  const submit = () => {
    if (!password) return;
    setError(null);
    confirm.mutate(
      { password, context },
      {
        onSuccess: () => {
          setPassword('');
          onConfirmed();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 429) {
            setError('Too many attempts. Wait a few minutes and try again.');
          } else {
            setError('That password is not right. The signature was not applied.');
          }
        },
      },
    );
  };

  return (
    <Dialog open={open} onClose={close} title="Confirm it’s you">
      <div className="flex flex-col gap-3">
        <p className="text-[13px] text-text-secondary">
          Applying your saved signature signs this document. Enter your password to confirm it’s
          you at the keyboard.
        </p>
        <Input
          type="password"
          value={password}
          autoFocus
          aria-label="Your password"
          placeholder="Your password"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
        />
        {error && (
          <p role="alert" className="text-[13px] text-text-danger">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!password || confirm.isPending}>
            Confirm and sign
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
