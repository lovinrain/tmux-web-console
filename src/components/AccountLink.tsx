import { ShieldIcon } from "../icons";

export function AccountLink() {
  return (
    <a
      className="account-link"
      href={`${import.meta.env.BASE_URL}account`}
      title="Manage remembered browsers and sign out"
    >
      <ShieldIcon />
      <span>Account</span>
    </a>
  );
}
