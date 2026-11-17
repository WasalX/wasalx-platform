const channelNames = ["slack", "whatsapp", "x", "tiktok", "instagram"] as const;
// WasalX-authored generic channel placeholder.
const channelPath = "M4 5h16v14H4ZM8 9h8M8 13h5";

const paths = {
  filter: "M4 5h16M7 12h10M10 19h4",
  group: "M3 4h6v6H3ZM15 4h6v6h-6ZM3 15h6v6H3ZM15 15h6v6h-6Z",
  sort: "M7 4v16m-4-4 4 4 4-4M14 5h7M14 10h5M14 15h3",
  settings: "M4 7h16M4 17h16M9 4v6M15 14v6",
  ticket: "M4 4h16v5a3 3 0 0 0 0 6v5H4v-5a3 3 0 0 0 0-6V4ZM14 7v2M14 12v2M14 17v1",
  reply: "m9 4-6 6 6 6M3 10h10a7 7 0 0 1 7 7v3",
  close: "m6 6 12 12M6 18 18 6",
  sun: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42",
  moon: "M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z",
  pause: "M9 5v14M15 5v14",
  play: "m8 5 11 7-11 7V5Z",
  groups: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  email: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm-2 2 10 7L22 6",
  person: "M20 21v-2a7 7 0 0 0-14 0v2M17 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  bot: "M12 3v3M9 3h3M6 7h12a2 2 0 0 1 2 2v10H4V9a2 2 0 0 1 2-2ZM8 12h.01M16 12h.01M8 16h8M1 11v5M23 11v5",
  monitor: "M4 20v-5M10 20V9M16 20V4M22 20V1",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  check: "m5 12 4 4L19 6",
  alert: "M10.3 3.9 1.8 18.1A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.9L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01",
  clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 6v6l4 2",
  link: "M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l2-2",
} as const;

export function MarketingIcon({ name }: { name: keyof typeof paths | (typeof channelNames)[number] }) {
  return <svg className={`marketing-icon marketing-icon-${name}`} width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={name in paths ? paths[name as keyof typeof paths] : channelPath} /></svg>;
}
