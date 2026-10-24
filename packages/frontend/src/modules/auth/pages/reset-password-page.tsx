import { Link } from 'react-router';

export default function ResetPasswordPage() {
  return (
    <>
      <h2 className="desktop-auth-heading">Reset your password</h2>
      <p className="desktop-auth-help">
        Orbis does not send password-reset emails. Ask the server administrator to run the recovery command on the server, then sign in with your new
        password.
      </p>
      <pre className="my-4">
        <code>./runtipi-cli reset-password</code>
      </pre>
      <Link to="/login" className="btn w-100">
        Back to sign in
      </Link>
    </>
  );
}
