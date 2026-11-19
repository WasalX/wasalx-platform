const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'",
};

/** One rendering rule for native preview and provider delivery. */
export function renderOutboundText(input:{text:string;contentType:string;agentDisplayName?:string|null;agentPrefix?:string|null;agentIdentityPlacement?:"HEADER"|"FOOTER"|"OFF"|null}) {
  // Consume unfinished tags too and decode entities once for plain-text delivery.
  const body=input.contentType==="text/html"
    ? input.text.replace(/<([^>]*)(?:>|$)|&(nbsp|amp|lt|gt|quot|#39);/giu, (match, tag: string | undefined, entity: string | undefined) => {
      if(entity!==undefined)return HTML_ENTITIES[entity.toLowerCase()]!;
      return match.endsWith(">")&&tag!==undefined&&/^(?:br\s*(?:\/\s*)?|\/p\s*)$/iu.test(tag)?"\n":"";
    })
    : input.text;
  if(!input.agentDisplayName||input.agentIdentityPlacement==="OFF")return body;
  const identity=`${input.agentPrefix?.trim()??"Agent:"} ${input.agentDisplayName}`.trim();
  return !body.trim()?identity:input.agentIdentityPlacement==="FOOTER"?`${body}\n${identity}`:`${identity}\n${body}`;
}

/** Keep native menu context aligned with WhatsApp numbered-text fallbacks. */
export function renderNumberedChoices(text:string,options:ReadonlyArray<{label:string}> = []) {
  return [text,...options.map((option,index)=>`${index+1}. ${option.label}`)].join("\n");
}
