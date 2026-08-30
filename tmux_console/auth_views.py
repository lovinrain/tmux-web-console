from __future__ import annotations

import html
from datetime import UTC, datetime

from .auth import RememberedDevice


def describe_browser(user_agent: str | None) -> str:
    value = user_agent or ""
    if "Edg/" in value:
        browser = "Edge"
    elif "OPR/" in value:
        browser = "Opera"
    elif "Firefox/" in value:
        browser = "Firefox"
    elif "Chrome/" in value or "CriOS/" in value:
        browser = "Chrome"
    elif "Safari/" in value:
        browser = "Safari"
    else:
        browser = "Browser"

    if "Android" in value:
        platform = "Android"
    elif "iPhone" in value or "iPad" in value:
        platform = "iOS"
    elif "Windows" in value:
        platform = "Windows"
    elif "Mac OS X" in value or "Macintosh" in value:
        platform = "macOS"
    elif "Linux" in value:
        platform = "Linux"
    else:
        platform = "this device"
    return f"{browser} on {platform}"


def _shell(*, title: str, eyebrow: str, body: str) -> str:
    escaped_title = html.escape(title)
    escaped_eyebrow = html.escape(eyebrow)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>{escaped_title} - Muxdeck</title>
  <style>
    :root {{
      color-scheme: dark;
      --paper: #0b1210;
      --panel: rgba(18, 29, 25, .94);
      --ink: #eef5ec;
      --muted: #9ba9a1;
      --line: rgba(222, 238, 228, .15);
      --acid: #bbf451;
      --red: #ff7368;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      min-height: 100vh;
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 18% 16%, rgba(187, 244, 81, .13), transparent 27rem),
        radial-gradient(circle at 82% 82%, rgba(64, 182, 168, .1), transparent 24rem),
        linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px),
        var(--paper);
      background-size: auto, auto, 32px 32px, 32px 32px, auto;
      font-family: "Trebuchet MS", "Avenir Next", sans-serif;
    }}
    main {{
      width: min(92vw, 540px);
      margin: 0 auto;
      padding: clamp(42px, 10vh, 110px) 0 54px;
    }}
    .brand {{ display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }}
    .mark {{
      display: grid; width: 48px; height: 48px; place-items: center;
      color: #10170f; background: var(--acid); border-radius: 3px 14px 3px 3px;
      font: 800 19px/1 ui-monospace, monospace; box-shadow: 0 0 34px rgba(187,244,81,.2);
    }}
    .brand p, .eyebrow {{
      margin: 0; color: var(--muted); font: 700 10px/1.4 ui-monospace, monospace;
      letter-spacing: .17em; text-transform: uppercase;
    }}
    .brand h1 {{ margin: 1px 0 0; font-size: 24px; letter-spacing: -.04em; }}
    .card {{
      position: relative; overflow: hidden; padding: clamp(25px, 6vw, 42px);
      border: 1px solid var(--line); border-radius: 4px 24px 4px 4px;
      background: var(--panel); box-shadow: 0 28px 90px rgba(0,0,0,.35);
    }}
    .card::before {{
      content: ""; position: absolute; inset: 0 auto 0 0; width: 3px;
      background: linear-gradient(var(--acid), transparent 76%);
    }}
    h2 {{ margin: 8px 0 10px; font-size: clamp(31px, 8vw, 48px); line-height: .98; letter-spacing: -.055em; }}
    .lede {{ margin: 0 0 28px; color: var(--muted); line-height: 1.55; }}
    label {{ display: grid; gap: 8px; margin-top: 17px; color: var(--muted); font: 700 11px/1.2 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }}
    input {{
      width: 100%; min-height: 48px; padding: 11px 13px; color: var(--ink);
      border: 1px solid var(--line); border-radius: 3px; outline: none;
      background: rgba(5, 10, 8, .7); font: 600 16px/1.2 ui-monospace, monospace;
    }}
    input:focus {{ border-color: var(--acid); box-shadow: 0 0 0 3px rgba(187,244,81,.1); }}
    button, .button-link {{
      display: inline-flex; min-height: 43px; align-items: center; justify-content: center;
      gap: 8px; padding: 10px 16px; border: 1px solid rgba(187,244,81,.45);
      border-radius: 3px 11px 3px 3px; color: #10170f; background: var(--acid);
      font: 800 12px/1 ui-monospace, monospace; letter-spacing: .04em;
      text-decoration: none; cursor: pointer;
    }}
    form > button {{ width: 100%; margin-top: 23px; }}
    button:hover, button:focus-visible, .button-link:hover, .button-link:focus-visible {{ filter: brightness(1.08); outline: none; }}
    .error {{
      margin: 18px 0 0; padding: 12px 14px; border: 1px solid rgba(255,115,104,.35);
      border-radius: 3px; color: #ffd3cf; background: rgba(255,115,104,.09); line-height: 1.4;
    }}
    .footnote {{ margin: 20px 0 0; color: var(--muted); font: 11px/1.55 ui-monospace, monospace; }}
    .account-head {{ display: flex; align-items: start; justify-content: space-between; gap: 20px; }}
    .account-head h2 {{ font-size: clamp(27px, 7vw, 42px); }}
    .device-list {{ display: grid; gap: 10px; margin: 25px 0 0; padding: 0; list-style: none; }}
    .device {{
      display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px;
      align-items: center; padding: 15px; border: 1px solid var(--line);
      border-radius: 3px 12px 3px 3px; background: rgba(5, 10, 8, .45);
    }}
    .device strong {{ display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
    .device small {{ display: block; margin-top: 5px; color: var(--muted); font: 10px/1.45 ui-monospace, monospace; }}
    .current {{ color: var(--acid); }}
    .device form {{ margin: 0; }}
    .device button, .secondary {{
      width: auto; min-height: 34px; margin: 0; padding: 8px 10px; color: var(--ink);
      border-color: var(--line); border-radius: 3px; background: transparent;
    }}
    .account-actions {{ display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }}
    .account-actions form {{ margin: 0; }}
    @media (max-width: 520px) {{
      .card {{ padding: 24px 21px; }}
      .account-head {{ display: block; }}
      .account-head .button-link {{ margin-top: 10px; }}
      .device {{ grid-template-columns: 1fr; }}
      .device button {{ width: 100%; }}
    }}
  </style>
</head>
<body>
  <main>
    <header class="brand">
      <span class="mark">&gt;_</span>
      <div><p>{escaped_eyebrow}</p><h1>Muxdeck</h1></div>
    </header>
    {body}
  </main>
</body>
</html>"""


def render_login_page(
    *, prefix: str, next_path: str, username: str = "", error: str | None = None
) -> str:
    escaped_prefix = html.escape(prefix, quote=True)
    escaped_next = html.escape(next_path, quote=True)
    escaped_username = html.escape(username, quote=True)
    error_html = (
        f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ""
    )
    body = f"""
    <section class="card">
      <p class="eyebrow">PRIVATE CONSOLE / AUTHENTICATE</p>
      <h2>Return to<br /> your terminals.</h2>
      <p class="lede">Sign in once on this browser profile. Your remembered login is shared across tabs and renewed as you use Muxdeck.</p>
      {error_html}
      <form method="post" action="{escaped_prefix}/login">
        <input type="hidden" name="next" value="{escaped_next}" />
        <label>Username
          <input name="username" value="{escaped_username}" autocomplete="username" required autofocus maxlength="64" />
        </label>
        <label>Password
          <input name="password" type="password" autocomplete="current-password" required maxlength="1024" />
        </label>
        <button type="submit">Unlock Muxdeck</button>
      </form>
      <p class="footnote">This creates a revocable device token. The password itself is never stored in this browser cookie.</p>
    </section>"""
    return _shell(title="Sign in", eyebrow="TMUX FIELD CONSOLE", body=body)


def _format_time(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, tz=UTC).strftime("%Y-%m-%d %H:%M UTC")


def render_account_page(
    *, prefix: str, username: str, devices: list[RememberedDevice], current_id: str
) -> str:
    escaped_prefix = html.escape(prefix, quote=True)
    device_rows: list[str] = []
    for device in devices:
        current = device.id == current_id
        current_html = ' <span class="current">(this browser)</span>' if current else ""
        device_rows.append(
            f"""<li class="device">
          <div>
            <strong>{html.escape(device.label)}{current_html}</strong>
            <small>Added {_format_time(device.created_at)}<br />Last used {_format_time(device.last_seen_at)}</small>
          </div>
          <form method="post" action="{escaped_prefix}/account/devices/{html.escape(device.id, quote=True)}/revoke">
            <button type="submit">{("Log out" if current else "Revoke")}</button>
          </form>
        </li>"""
        )
    body = f"""
    <section class="card">
      <div class="account-head">
        <div>
          <p class="eyebrow">SIGNED IN / {html.escape(username)}</p>
          <h2>Remembered<br /> browsers.</h2>
        </div>
        <a class="button-link secondary" href="{escaped_prefix}/">Back to Muxdeck</a>
      </div>
      <p class="lede">These browser profiles can access the console without entering the password. Revoke anything you no longer recognize or use.</p>
      <ul class="device-list">{"".join(device_rows)}</ul>
      <div class="account-actions">
        <form method="post" action="{escaped_prefix}/logout"><button class="secondary" type="submit">Log out this browser</button></form>
      </div>
    </section>"""
    return _shell(title="Account", eyebrow="TMUX FIELD CONSOLE", body=body)


def render_auth_mode_page(*, prefix: str, mode: str, username: str = "") -> str:
    escaped_prefix = html.escape(prefix, quote=True)
    if mode == "basic":
        eyebrow = f"SIGNED IN / {html.escape(username)}"
        heading = "HTTP Basic<br /> authentication."
        description = (
            "Your browser supplies credentials for each request. Muxdeck does not "
            "create remembered-device cookies in this mode and cannot reliably sign "
            "the browser out. Close the browser or clear its saved site credentials "
            "when you need to forget this login."
        )
    else:
        eyebrow = "AUTHENTICATION / DISABLED"
        heading = "No application<br /> login."
        description = (
            "Anyone who can reach this Muxdeck instance can control terminals with "
            "the service user's privileges. Keep it on a trusted loopback, tunnel, "
            "or separately protected network."
        )
    body = f"""
    <section class="card">
      <div class="account-head">
        <div>
          <p class="eyebrow">{eyebrow}</p>
          <h2>{heading}</h2>
        </div>
        <a class="button-link secondary" href="{escaped_prefix}/">Back to Muxdeck</a>
      </div>
      <p class="lede">{description}</p>
    </section>"""
    return _shell(title="Authentication", eyebrow="TMUX FIELD CONSOLE", body=body)
