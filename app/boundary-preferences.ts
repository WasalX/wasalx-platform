"use client";

import {createContext,createElement,useContext,useSyncExternalStore,type ReactNode} from "react";
import {localeFromLanguageTag,type Locale} from "../lib/i18n/locales.ts";

export type BoundarySurface="public"|"tenant"|"platform";
export type BoundaryTheme="dark"|"light";
export const boundaryLocaleStorageKey="wasalx:locale";
type BoundaryPreferenceSeedValue={locale:Locale;tenantTheme:BoundaryTheme;platformTheme:BoundaryTheme};
const BoundaryPreferenceContext=createContext<BoundaryPreferenceSeedValue|null>(null);

export function BoundaryPreferenceSeed({value,children}:{value:BoundaryPreferenceSeedValue;children:ReactNode}){
  return createElement(BoundaryPreferenceContext.Provider,{value},children);
}

export function recoverySurface(pathname:string):BoundarySurface{
  if(pathname.startsWith("/platform"))return"platform";
  if(pathname.startsWith("/app")||pathname.startsWith("/auth")||pathname.startsWith("/invitations"))return"tenant";
  return"public";
}

export function resolveBoundaryLocale(input:{stored?:string|null;documentLanguage?:string|null;navigatorLanguage?:string|null;documentIsFallback?:boolean}):Locale{
  return localeFromLanguageTag(input.stored)
    ??(input.documentIsFallback?null:localeFromLanguageTag(input.documentLanguage))
    ??localeFromLanguageTag(input.navigatorLanguage)
    ??localeFromLanguageTag(input.documentLanguage)
    ??"en";
}

export function resolveBoundaryTheme(input:{stored?:string|null;domTheme?:string|null;prefersLight?:boolean;documentIsFallback?:boolean}):BoundaryTheme{
  if(input.stored==="dark"||input.stored==="light")return input.stored;
  if(!input.documentIsFallback&&(input.domTheme==="dark"||input.domTheme==="light"))return input.domTheme;
  return input.prefersLight?"light":"dark";
}

export function rememberBoundaryLocale(locale:Locale){try{localStorage.setItem(boundaryLocaleStorageKey,locale)}catch{/* Browser storage can be unavailable. */}}

export function rememberBoundaryTheme(surface:Exclude<BoundarySurface,"public">,theme:BoundaryTheme,persist=true){
  if(persist){try{localStorage.setItem(surface==="platform"?"wasalx-platform-theme":"wasalx.theme",theme)}catch{/* Browser storage can be unavailable. */}}
  try{
    const secure=location.protocol==="https:";
    const name=`${secure?"__Host-":""}wasalx_${surface==="platform"?"platform_":""}theme`;
    document.cookie=`${name}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${secure?"; Secure":""}`;
  }catch{/* Cookies can be unavailable in recovery contexts. */}
}

export function useBoundaryPreferences(fallbackSurface?:BoundarySurface):{surface:BoundarySurface;locale:Locale;theme:BoundaryTheme};
export function useBoundaryPreferences(fallbackSurface:BoundarySurface|undefined,neutralServer:true):{surface:BoundarySurface;locale:Locale|null;theme:BoundaryTheme};
export function useBoundaryPreferences(fallbackSurface?:BoundarySurface,neutralServer=false){
  const seed=useContext(BoundaryPreferenceContext);
  const serverSurface=fallbackSurface??"public";
  const surface=useSyncExternalStore(subscribe,readSurface,()=>serverSurface);
  const locale=useSyncExternalStore<Locale|null>(subscribe,readLocale,()=>neutralServer?null:seed?.locale??"en");
  const serverTheme=surface==="platform"?seed?.platformTheme:surface==="tenant"?seed?.tenantTheme:undefined;
  const theme=useSyncExternalStore(subscribe,()=>readTheme(surface),()=>serverTheme??"dark");
  return{surface,locale,theme};
}

function subscribe(listener:()=>void){
  addEventListener("storage",listener);
  const media=matchMedia("(prefers-color-scheme: light)");media.addEventListener("change",listener);
  return()=>{removeEventListener("storage",listener);media.removeEventListener("change",listener)};
}
function readSurface(){return recoverySurface(location.pathname)}
function readLocale(){
  let stored:string|null=null;try{stored=localStorage.getItem(boundaryLocaleStorageKey)}catch{/* Browser storage can be unavailable. */}
  return resolveBoundaryLocale({stored,documentLanguage:document.documentElement.lang,navigatorLanguage:navigator.language,documentIsFallback:document.body.dataset.globalRecovery==="true"});
}
function readTheme(surface:BoundarySurface){
  const key=surface==="platform"?"wasalx-platform-theme":surface==="tenant"?"wasalx.theme":null;
  let stored:string|null=null;try{stored=key?localStorage.getItem(key):null}catch{/* Browser storage can be unavailable. */}
  if(!stored&&surface!=="public"){
    const names=[`__Host-wasalx_${surface==="platform"?"platform_":""}theme`,`wasalx_${surface==="platform"?"platform_":""}theme`];
    stored=document.cookie.split(/;\s*/u).map(value=>value.split("=",2)).find(([name])=>names.includes(name))?.[1]??null;
  }
  const active=document.querySelector<HTMLElement>(".theme-dark:not([data-boundary-recovery]), .theme-light:not([data-boundary-recovery])");
  const domTheme=active?(active.classList.contains("theme-light")?"light":"dark"):null;
  return resolveBoundaryTheme({stored,domTheme,prefersLight:matchMedia("(prefers-color-scheme: light)").matches,documentIsFallback:document.body.dataset.globalRecovery==="true"});
}
