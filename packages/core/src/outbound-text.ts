const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
};

function decodeEntities(text: string) {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39);/giu, (_, entity: string) => HTML_ENTITIES[entity.toLowerCase()]!);
}

function htmlToPlainText(text: string) {
  const parts: string[] = [];
  let start = 0;
  for (;;) {
    const open = text.indexOf("<", start);
    if (open === -1) break;
    const close = text.indexOf(">", open + 1);
    if (close === -1) break;

    parts.push(decodeEntities(text.slice(start, open)));
    const tag = text.slice(open + 1, close);
    if (/^(?:br\s*(?:\/\s*)?|\/p\s*)$/iu.test(tag)) parts.push("\n");
    start = close + 1;
  }
  parts.push(decodeEntities(text.slice(start)));
  return parts.join("");
}

/** One rendering rule for native preview and provider delivery. */
export function renderOutboundText(input:{text:string;contentType:string;agentDisplayName?:string|null;agentPrefix?:string|null;agentIdentityPlacement?:"HEADER"|"FOOTER"|"OFF"|null}) {
  const body=input.contentType==="text/html"?htmlToPlainText(input.text):input.text;
  if(!input.agentDisplayName||input.agentIdentityPlacement==="OFF")return body;
  const identity=`${input.agentPrefix?.trim()??"Agent:"} ${input.agentDisplayName}`.trim();
  return !body.trim()?identity:input.agentIdentityPlacement==="FOOTER"?`${body}\n${identity}`:`${identity}\n${body}`;
}

/** Keep native menu context aligned with WhatsApp numbered-text fallbacks. */
export function renderNumberedChoices(text:string,options:ReadonlyArray<{label:string}> = []) {
  return [text,...options.map((option,index)=>`${index+1}. ${option.label}`)].join("\n");
}
