/** One rendering rule for native preview and provider delivery. */
export function renderOutboundText(input:{text:string;contentType:string;agentDisplayName?:string|null;agentPrefix?:string|null;agentIdentityPlacement?:"HEADER"|"FOOTER"|"OFF"|null}) {
  const body=input.contentType==="text/html"?input.text.replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/p\s*>/gi,"\n").replace(/<[^>]*>/g,"").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'"):input.text;
  if(!input.agentDisplayName||input.agentIdentityPlacement==="OFF")return body;
  const identity=`${input.agentPrefix?.trim()??"Agent:"} ${input.agentDisplayName}`.trim();
  return !body.trim()?identity:input.agentIdentityPlacement==="FOOTER"?`${body}\n${identity}`:`${identity}\n${body}`;
}

/** Keep native menu context aligned with WhatsApp numbered-text fallbacks. */
export function renderNumberedChoices(text:string,options:ReadonlyArray<{label:string}> = []) {
  return [text,...options.map((option,index)=>`${index+1}. ${option.label}`)].join("\n");
}
