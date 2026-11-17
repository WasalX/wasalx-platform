export type DirectLocation={latitude:number;longitude:number;name?:string;address?:string};

export function directLocationText(location:DirectLocation){
  if(!Number.isFinite(location.latitude)||location.latitude < -90||location.latitude > 90||!Number.isFinite(location.longitude)||location.longitude < -180||location.longitude > 180)throw new Error("Direct location coordinates are invalid");
  const name=optionalLocationLabel(location.name,160);const address=optionalLocationLabel(location.address,500);
  const latitude=String(location.latitude);const longitude=String(location.longitude);
  return[
    name??"WhatsApp location",
    ...(address&&address!==name?[`Address: ${address}`]:[]),
    `Coordinates: ${latitude}, ${longitude}`,
    `Map: https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=18/${latitude}/${longitude}`,
  ].join("\n");
}

export function optionalLocationLabel(value:unknown,maximum:number){
  if(value===undefined)return undefined;
  const normalized=typeof value==="string"?value.replace(/[\t\n\r]+/gu," "):"";
  if(normalized.length<1||normalized.length>maximum||Array.from(normalized).some(character=>{const code=character.charCodeAt(0);return code<32||code===127}))throw new Error("Direct location label is invalid");
  return normalized;
}
