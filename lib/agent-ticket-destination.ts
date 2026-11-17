export function agentTicketDestination(requestUrl: string, ticketNumber: string) {
  if (!/^[1-9][0-9]{0,15}$/u.test(ticketNumber)) throw Object.assign(new Error("Ticket is unavailable"), { status: 404 });
  const url = new URL("/app", requestUrl);
  url.searchParams.set("view", "inbox");
  url.searchParams.set("ticket", ticketNumber);
  return url.href;
}
