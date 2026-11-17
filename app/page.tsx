import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getMessages } from "../lib/i18n/messages/index.ts";
import { englishMarketingMessages } from "../lib/i18n/messages/en/marketing.ts";
import { arabicMarketingMessages } from "../lib/i18n/messages/ar/marketing.ts";
import { getRequestLocale } from "../lib/i18n/request-locale.ts";
import { createTranslator } from "../lib/i18n/translate.ts";
import { LocaleSwitcher } from "./LocaleSwitcher";
import { MarketingIcon } from "./MarketingIcon";
import { MarketingInbox } from "./MarketingInbox";
import { MarketingHeadline, MarketingMotion, MarketingThemeToggle } from "./MarketingMotion";
import "./marketing.css";

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;
const legacyTenantKeys = ["view", "connection", "delivery", "ticket", "routingIntegration"] as const;

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const t = createTranslator(getMessages(locale));
  return { title: t("marketing.metadata.title"), description: t("marketing.metadata.description") };
}

export default async function MarketingPage({ searchParams }: { searchParams: PageSearchParams }) {
  const [query, locale, cookieStore] = await Promise.all([searchParams, getRequestLocale(), cookies()]);
  const initialTheme = [cookieStore.get("__Host-wasalx_theme")?.value, cookieStore.get("wasalx_theme")?.value].find(value => value === "dark" || value === "light") ?? "light";
  const legacy = new URLSearchParams();
  for (const key of legacyTenantKeys) {
    const value = query[key];
    if (typeof value === "string") legacy.set(key, value);
  }
  if (legacy.has("view") || legacyTenantKeys.slice(1).some((key) => legacy.has(key))) redirect(`/app?${legacy.toString()}`);
  const t = createTranslator(getMessages(locale));
  const contactEmail = process.env.PUBLIC_CONTACT_EMAIL?.trim() || "contact@example.invalid";
  const upcomingChannels = (["instagram", "x", "tiktok", "slack"] as const).map(channel => ({ channel, text: t(`marketing.channels.${channel}`) }));

  return (
    <MarketingMotion initialTheme={initialTheme}>
      {locale === "ar" && <link rel="preload" href="/fonts/NotoSansArabic-Variable.woff2" as="font" type="font/woff2" crossOrigin="anonymous"/>}
      <a className="marketing-skip" href="#main">{t("marketing.navigation.skip")}</a>
      <header className="marketing-header">
        <Link className="marketing-brand" href="/" aria-label={t("marketing.navigation.homeAria")} dir="ltr">Wasal<span>X</span></Link>
        <nav aria-label={t("marketing.navigation.primary")}>
          <a href="#product">{t("marketing.navigation.product")}</a>
          <a href="#contact">{t("marketing.navigation.contact")}</a>
        </nav>
        <div className="marketing-header-actions">
          <a href="/auth/login?return_to=/app">{t("common.actions.signIn")}</a>
          <LocaleSwitcher locale={locale} label={t("common.locale.label")} errorMessage={t("common.errors.generic")}/>
          <MarketingThemeToggle light={t("tenant.theme.switchLight")} dark={t("tenant.theme.switchDark")}/>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <section className="marketing-hero" aria-labelledby="marketing-title">
          <MarketingHeadline title={t("marketing.hero.title")} ending={t("marketing.hero.titleEnd")} soon={t("marketing.channels.soon")} words={[{ text: t("marketing.hero.title") }, { text: t("marketing.channels.groups"), whatsapp: true }, { text: t("marketing.channels.bot"), whatsapp: true }, { text: t("marketing.channels.email") }, ...upcomingChannels.map(({ text }) => ({ text, upcoming: true }))]}/>
          <p>{t("marketing.hero.body")}</p>
          <div className="marketing-hero-actions"><a className="wx-button wx-button-primary" href="#product">{t("marketing.hero.primaryAction")}<MarketingIcon name="arrow"/></a></div>
          <div className="marketing-channels">
            <ul><li><MarketingIcon name="whatsapp"/>{t("marketing.channels.whatsapp")}</li><li><MarketingIcon name="email"/>{t("marketing.channels.email")}</li></ul>
            <div className="marketing-upcoming" role="group" aria-labelledby="upcoming-label"><strong id="upcoming-label">{t("marketing.channels.soon")}</strong><ul>{upcomingChannels.map(({ channel, text }) => <li key={channel}><MarketingIcon name={channel}/><bdi>{text}</bdi></li>)}</ul></div>
          </div>
        </section>
        <MarketingInbox locale={locale} messages={locale === "ar" ? arabicMarketingMessages : englishMarketingMessages}/>
        <ol className="marketing-actions">
          <li><MarketingIcon name="email"/><strong>{t("marketing.actions.receive")}</strong><span>{t("marketing.actions.receiveDetail")}</span></li>
          <li><MarketingIcon name="person"/><strong>{t("marketing.actions.assign")}</strong><span>{t("marketing.actions.assignDetail")}</span></li>
          <li><MarketingIcon name="chat"/><strong>{t("marketing.actions.reply")}</strong><span>{t("marketing.actions.replyDetail")}</span></li>
          <li><MarketingIcon name="monitor"/><strong>{t("marketing.actions.monitor")}</strong><span>{t("marketing.actions.monitorDetail")}</span></li>
        </ol>
        <section className="marketing-groups" aria-labelledby="groups-title">
          <div className="marketing-section-inner">
            <div className="marketing-section-copy"><h2 id="groups-title">{t("marketing.groups.title")}</h2><p>{t("marketing.groups.body")}</p><p className="marketing-trigger-description"><MarketingIcon name="settings"/><span>{t("marketing.groups.rules")}</span></p><p className="marketing-availability"><MarketingIcon name="whatsapp"/>{t("marketing.groups.availability")}</p><ul>
              <li><MarketingIcon name="check"/>{t("marketing.groups.context")}</li><li><MarketingIcon name="check"/>{t("marketing.groups.owner")}</li><li><MarketingIcon name="check"/>{t("marketing.groups.reply")}</li>
            </ul></div>
            <div className="marketing-group-example" data-motion-scene>
              <div className="inbox-conversation-header"><span><strong>{t("marketing.inbox.group")}</strong><small>{t("marketing.inbox.groupContext")}</small></span><MarketingIcon name="whatsapp"/></div>
              <div className="marketing-group-rule"><MarketingIcon name="settings"/><span><strong>{t("marketing.groups.ruleLabel")}</strong><span>{t("marketing.groups.ruleExample")}</span></span><span className="marketing-rule-active"><MarketingIcon name="check"/>{t("marketing.demo.active")}</span></div>
              <div className="inbox-assignment marketing-group-ticket"><strong><MarketingIcon name="ticket"/>{t("marketing.groups.ticket")}</strong><span>{t("marketing.inbox.fahad")} · {t("marketing.inbox.operations")}</span><span className="inbox-ticket-state" data-state="open">{t("marketing.demo.open")}</span></div>
              <div className="inbox-messages">
                <div className="inbox-message inbox-message-trigger"><span className="inbox-avatar" aria-hidden="true">{t("marketing.inbox.ahmed").slice(0, 1)}</span><div><div className="inbox-message-meta"><strong>{t("marketing.inbox.ahmed")}</strong><span className="inbox-author-role">{t("marketing.demo.customerRole")}</span><span className="inbox-trigger-label"><MarketingIcon name="settings"/>{t("marketing.demo.triggerMessage")}</span></div><div className="inbox-bubble"><p>{t("marketing.demo.numberMessage").split(/(1234567890)/u).map((part, index) => part === "1234567890" ? <mark key={index}>{part}</mark> : part)}</p></div><span className="inbox-trigger"><span><MarketingIcon name="check"/>{t("marketing.groups.matched")}</span></span></div></div>
                <div className="inbox-message"><span className="inbox-avatar" aria-hidden="true">{t("marketing.inbox.mona").slice(0, 1)}</span><div><div className="inbox-message-meta"><strong>{t("marketing.inbox.mona")}</strong><span className="inbox-author-role">{t("marketing.demo.customerRole")}</span></div><div className="inbox-bubble"><blockquote><strong>{t("marketing.inbox.ahmed")}</strong><span>{t("marketing.demo.numberMessage")}</span></blockquote><p>{t("marketing.inbox.followUp")}</p></div></div></div>
                <div className="inbox-message inbox-message-outbound"><div><div className="inbox-message-meta"><strong>{t("marketing.inbox.fahad")}</strong><span className="inbox-author-role">{t("marketing.demo.teamRole")}</span></div><div className="inbox-bubble"><blockquote><strong>{t("marketing.inbox.mona")}</strong><span>{t("marketing.inbox.followUp")}</span></blockquote><p>{t("marketing.inbox.reply")} <MarketingIcon name="check"/></p></div><span className="inbox-ticket-note">{t("marketing.groups.linked")}</span></div></div>
              </div>
            </div>
          </div>
        </section>
        <section className="marketing-workflows" aria-labelledby="workflows-title">
          <div className="marketing-section-inner">
            <div className="marketing-section-copy">
              <h2 id="workflows-title">{t("marketing.workflows.title")}</h2>
              <p>{t("marketing.workflows.body")}</p>
            </div>
            <figure className="marketing-flow-canvas" aria-labelledby="flow-caption">
              <figcaption id="flow-caption">{t("marketing.workflows.example")}</figcaption>
              <section className="marketing-flow-example" aria-labelledby="flow-groups-title">
                <h3 id="flow-groups-title">{t("marketing.workflows.groupTitle")}</h3>
                <ol className="marketing-flow-steps">
                  <li className="marketing-flow-node"><MarketingIcon name="whatsapp"/><span><strong>{t("marketing.workflows.group")}</strong><small><bdi dir="ltr">/status ORD-42</bdi></small></span><MarketingIcon name="arrow"/></li>
                  <li className="marketing-flow-node marketing-flow-action"><MarketingIcon name="link"/><span><small>{t("marketing.workflows.api")}</small><strong>{t("marketing.workflows.lookup")}</strong></span><MarketingIcon name="arrow"/></li>
                  <li className="marketing-flow-node"><MarketingIcon name="reply"/><span><small>{t("marketing.workflows.reply")}</small><strong>{t("marketing.workflows.result")}</strong></span></li>
                </ol>
              </section>
              <section className="marketing-flow-example" aria-labelledby="flow-bot-title">
                <h3 id="flow-bot-title">{t("marketing.workflows.botTitle")}</h3>
                <ol className="marketing-flow-steps">
                  <li className="marketing-flow-node"><MarketingIcon name="bot"/><span><small>{t("marketing.workflows.bot")}</small><strong>{t("marketing.workflows.request")}</strong></span><MarketingIcon name="arrow"/></li>
                  <li className="marketing-flow-node"><MarketingIcon name="settings"/><span><small>{t("marketing.workflows.choose")}</small><strong>{t("marketing.workflows.options")}</strong></span><MarketingIcon name="arrow"/></li>
                  <li className="marketing-flow-node"><MarketingIcon name="person"/><span><strong>{t("marketing.workflows.handoff")}</strong><small>{t("marketing.workflows.history")}</small></span></li>
                </ol>
              </section>
              <section className="marketing-flow-example" aria-labelledby="flow-ticket-title">
                <h3 id="flow-ticket-title">{t("marketing.workflows.ticketTitle")}</h3>
                <ol className="marketing-flow-steps">
                  <li className="marketing-flow-node"><MarketingIcon name="ticket"/><span><strong>{t("marketing.workflows.closed")}</strong><small>{t("marketing.workflows.groupTicket")}</small></span><MarketingIcon name="arrow"/></li>
                  <li className="marketing-flow-node"><MarketingIcon name="chat"/><strong>{t("marketing.workflows.confirm")}</strong><MarketingIcon name="arrow"/></li>
                  <li className="marketing-flow-node"><MarketingIcon name="whatsapp"/><span><strong>{t("marketing.workflows.notify")}</strong><small>{t("marketing.workflows.quoted")}</small></span></li>
                </ol>
              </section>
            </figure>
            <div className="marketing-bot-channels"><strong>{t("marketing.bot.upcoming")}</strong><ul>{upcomingChannels.map(({ channel, text }) => <li key={channel}><MarketingIcon name={channel}/><bdi>{text}</bdi></li>)}</ul></div>
          </div>
        </section>
        <section className="marketing-connected" aria-labelledby="email-title">
          <div><h2 id="email-title">{t("marketing.email.title")}</h2><p>{t("marketing.email.body")}</p></div>
          <div className="marketing-email-example" data-motion-scene><MarketingIcon name="email"/><span><strong>{t("marketing.inbox.email")}</strong><small>{t("marketing.inbox.noura")} · {t("marketing.inbox.customerSupport")}</small></span><span className="inbox-status">{t("marketing.inbox.replied")}</span></div>
        </section>
        <section className="marketing-close" id="contact" aria-labelledby="contact-title" tabIndex={-1}>
          <h2 id="contact-title">{t("marketing.contact.title")}</h2><p>{t("marketing.contact.body")}</p>
          <div className="marketing-contact-actions">
            <a className="wx-button wx-button-primary" href={`mailto:${contactEmail}`}>{t("marketing.contact.action")}<MarketingIcon name="arrow"/></a>
            <a className="marketing-contact-address" href={`mailto:${contactEmail}`}><bdi dir="ltr">{contactEmail}</bdi></a>
          </div>
        </section>
      </main>
      <footer className="marketing-footer"><Link className="marketing-brand" href="/" aria-label={t("marketing.navigation.homeAria")} dir="ltr">Wasal<span>X</span></Link><div className="marketing-footer-copy"><p>{t("marketing.footer.body")}</p><p>{t("marketing.footer.built")}</p></div><span>© {new Date().getFullYear()} WasalX</span></footer>
    </MarketingMotion>
  );
}
