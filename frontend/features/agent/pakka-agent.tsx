/* eslint-disable */
// @ts-nocheck: TEMPORARY typing boundary. Ported prototype code written for `strict: false`;
// typing it is a follow-up (docs/frontend-architecture-map.md, "TypeScript").
"use client";
// Ported from the "Pakka App First Round" design. Logic and mock data are kept as authored;
// the markup is the original template expressed as JSX.

import Link from "next/link";
import React, { Fragment } from "react";
import { DCLogic, createDC, I, L, css } from "@/components/dashboard/runtime";
import { CRIT, TRIG, LANGS } from "@/fixtures/dashboard/agent";
import { PAKKA_IND } from "@/fixtures/dashboard/industries";


/** Editable props declared by the original component (editor metadata, kept for reference). */
export const PakkaAgentProps = {"industry":{"editor":"enum","options":["re","salon","int","hotel","rest"],"default":"re"},"isMobile":{"editor":"boolean","default":false}} as const;

const IX=k=>(k&&k!=='re'&&PAKKA_IND&&PAKKA_IND[k])||null;
const DAYS: any=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const sw=on=>({bd:on?'var(--color-accent)':'var(--color-neutral-500)',tbg:on?'var(--color-accent)':'transparent',kl:on?'20px':'2px',kb:on?'#fff':'var(--color-neutral-500)'});
// Handover reasons that always apply (stuck, credits run out): the backend does not let a business switch them off, so they are not offered.
const NOT_SWITCHABLE=['stuck','credits'];

class PakkaAgentLogic extends DCLogic {
  state: any = {persona:'Maya',tone:'friendly',langs:{English:true,Tamil:true,Tanglish:true,Malayalam:false,Hindi:false,Telugu:false},open:{Mon:true,Tue:true,Wed:true,Thu:true,Fri:true,Sat:true,Sun:false},w:Object.fromEntries(CRIT.map(c=>[c[0],c[3]])),hot:70,warm:40,trig:Object.fromEntries(TRIG.map(t=>[t[0],t[4]])),mode:'shared',dirty:false,saved:false,wk:'re',openK:'re'};
  componentDidMount(){if(!PAKKA_IND){this._rd=()=>this.forceUpdate();window.addEventListener('pakka-ind-ready',this._rd);}}
  set(p){this.setState({...p,dirty:true,saved:false});}
  renderVals(){
    const s=this.state,m=!!this.props.isMobile,X=IX(this.props.industry),K=X?this.props.industry:'re',A=X?X.agent:null,CR=A?A.crit:CRIT;
    const wcur=s.wk===K?s.w:Object.fromEntries(CR.map(c=>[c[0],c[3]]));
    const ocur=s.openK===K?s.open:(A?{Mon:true,Tue:true,Wed:true,Thu:true,Fri:true,Sat:true,Sun:A.sun}:s.open);
    const total=Object.values(wcur).reduce((a:any,b:any)=>a+b,0);
    const p=s.persona||'Maya';
    return{
      pad:m?'20px 16px 0':'32px 40px 0',h1:m?'30px':'42px',twoCol:m?'minmax(0,1fr)':'minmax(0,1fr) minmax(0,1fr)',threeCol:m?'minmax(0,1fr)':'repeat(3,minmax(0,1fr))',
      persona:s.persona,initial:p[0].toUpperCase(),onPersona:e=>this.set({persona:e.target.value}),
      setFriendly:()=>this.set({tone:'friendly'}),setFormal:()=>this.set({tone:'formal'}),
      frBg:s.tone==='friendly'?'var(--color-text)':'transparent',frFg:s.tone==='friendly'?'var(--color-bg)':'var(--color-text)',fmBg:s.tone==='formal'?'var(--color-text)':'transparent',fmFg:s.tone==='formal'?'var(--color-bg)':'var(--color-text)',
      custMsg:A?A.cust:'Hi, Velachery la 3BHK irukka?',bizName:X?X.biz.name:'Skyline Homes',
      preview:A?A[s.tone].split('{p}').join(p):s.tone==='friendly'?`Vanakkam! I’m ${p}, Skyline Homes’ assistant. Yes, Skyline Aster has ready-to-move 3BHKs. What budget are you looking at?`:`Good morning. This is ${p}, assistant at Skyline Homes. Ready-to-move 3BHK homes are available at Skyline Aster, Velachery. May I know your budget?`,
      langs:LANGS.map(n=>{const on=s.langs[n];return{name:n,flip:()=>this.set({langs:{...s.langs,[n]:!on}}),bg:on?'var(--color-text)':'transparent',fg:on?'var(--color-bg)':'var(--color-text)',bd:on?'var(--color-text)':'var(--color-divider)'};}),
      hourCols:m?'44px 44px 1fr':'80px 44px 1fr',
      hours:DAYS.map(d=>{const o=ocur[d];return{day:d,open:o,...sw(o),flip:()=>this.set({open:{...ocur,[d]:!o},openK:K}),text:o?(A?(d==='Sat'||d==='Sun'?A.sat:A.wk):(d==='Sat'?'10:00 am – 6:00 pm':'9:30 am – 7:00 pm')):'Closed · Maya takes bookings for Monday',fg:o?'var(--color-text)':'var(--color-neutral-700)'};}),
      criteria:CR.map(([k,name,rule])=>({name,rule,w:wcur[k],set:e=>this.set({w:{...wcur,[k]:+e.target.value},wk:K})})),
      critCols:m?'minmax(0,1fr) 40px':'minmax(0,1fr) 220px 40px',
      weightTotal:total,weightColor:total===100?'var(--color-neutral-700)':'var(--color-accent-700)',
      hot:s.hot,warm:s.warm,setHot:e=>this.set({hot:Math.max(+e.target.value,s.warm+5)}),setWarm:e=>this.set({warm:Math.min(+e.target.value,s.hot-5)}),
      coldPct:s.warm+'%',warmPct:(s.hot-s.warm)+'%',
      triggers:TRIG.filter(t=>!NOT_SWITCHABLE.includes(t[0])).map(([k,name,ex,high])=>{const on=s.trig[k];return{name,ex:A&&k==='quote'?A.quoteEx:A&&k==='hot'?A.hotEx:ex,high,on,...sw(on),bd:on?'var(--color-accent)':'var(--color-neutral-500)',kl:on?'22px':'2px',flip:()=>this.set({trig:{...s.trig,[k]:!on}})};}),
      modes:[['shared','Shared inbox','Staff reply here in the dashboard. Every message is saved and Maya can pick up later.'],['own','Own number','Staff get a tap-to-chat link and continue from their personal WhatsApp.'],['ask','Ask each time','The staff alert shows both buttons so they choose.']].map(([k,name,desc])=>({name,desc,pick:()=>this.set({mode:k}),bd:s.mode===k?'var(--color-accent)':'var(--color-divider)',bg:s.mode===k?'var(--color-accent-100)':'transparent',dot:s.mode===k?'var(--color-accent)':'transparent'})),
      // Nothing here is written anywhere yet (no write contract for agent_settings is confirmed), so it never says "Saved".
      saveNote:'Preview only: these settings are not saved yet, and changing them does not change how your assistant replies.',
    };
  }
}

function renderPakkaAgent($v: any) {
  return (
    <>
      <div data-screen-label="08 Agent settings" style={{ position: "relative", padding: `${$v.pad ?? ""}`, display: "flex", flexDirection: "column", gap: "36px", maxWidth: "960px", color: "var(--color-text)", fontFamily: "var(--font-body)" } as React.CSSProperties}>
        {" "}
        <div>
          {" "}
          <h1 style={{ margin: "0", fontSize: `${$v.h1 ?? ""}` } as React.CSSProperties}>
            Agent settings
          </h1>
          {" "}
          <p style={{ margin: "4px 0 0", color: "var(--color-neutral-700)" }}>
            How Maya sounds, what she asks, and when she hands over.
          </p>
          {" "}
        </div>
        {" "}
        <section style={{ display: "grid", gridTemplateColumns: `${$v.twoCol ?? ""}`, gap: "28px" } as React.CSSProperties}>
          {" "}
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {" "}
            <h2 style={{ margin: "0", fontSize: "13px", letterSpacing: ".08em", textTransform: "uppercase", borderBottom: "2px solid var(--color-text)", paddingBottom: "8px" }}>
              Persona
            </h2>
            {" "}
            <div style={{ display: "flex", gap: "14px", alignItems: "center" }}>
              {" "}
              <span style={{ width: "64px", height: "64px", background: "var(--color-accent)", color: "#fff", display: "grid", placeItems: "center", fontWeight: "800", fontSize: "28px", flex: "none" }}>
                {I($v.initial)}
              </span>
              {" "}
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <button className="btn btn-secondary" style={{ justifyContent: "flex-start" }}>
                  Change photo
                </button>
                <span style={{ fontSize: "12px", color: "var(--color-neutral-700)" }}>
                  Shows as the WhatsApp profile photo
                </span>
              </div>
              {" "}
            </div>
            {" "}
            <div className="field">
              <label>
                Assistant name
              </label>
              <input className="input" value={$v.persona ?? ""} onChange={$v.onPersona} />
            </div>
            {" "}
            <div className="field">
              <label>
                Tone
              </label>
              {" "}
              <div style={{ display: "flex", border: "2px solid var(--color-text)", alignSelf: "flex-start", width: "max-content" }}>
                {" "}
                <button onClick={$v.setFriendly} style={{ padding: "7px 16px", border: "0", background: `${$v.frBg ?? ""}`, color: `${$v.frFg ?? ""}`, font: "inherit", fontSize: "14px", fontWeight: "800", cursor: "pointer" } as React.CSSProperties}>
                  Friendly
                </button>
                {" "}
                <button onClick={$v.setFormal} style={{ padding: "7px 16px", border: "0", background: `${$v.fmBg ?? ""}`, color: `${$v.fmFg ?? ""}`, font: "inherit", fontSize: "14px", fontWeight: "800", cursor: "pointer" } as React.CSSProperties}>
                  Formal
                </button>
                {" "}
              </div>
              {" "}
            </div>
            {" "}
            <div className="field">
              <label>
                Languages
              </label>
              {" "}
              <p data-testid="agent-languages" style={{ margin: "0", fontSize: "14px", color: "var(--color-neutral-700)" }}>
                {I($v.persona)}{" detects each customer’s language and replies in it. There is nothing to switch on or off."}
              </p>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {" "}
            <h2 style={{ margin: "0", fontSize: "13px", letterSpacing: ".08em", textTransform: "uppercase", borderBottom: "2px solid var(--color-text)", paddingBottom: "8px" }}>
              Preview
            </h2>
            {" "}
            <div style={{ background: "var(--wa-bg,#efeae2)", padding: "14px", display: "flex", flexDirection: "column", gap: "6px", color: "var(--wa-ink,#111b21)" }}>
              {" "}
              <div style={{ alignSelf: "flex-start", maxWidth: "85%", background: "var(--wa-in,#fff)", padding: "6px 9px", fontSize: "14px" }}>
                {I($v.custMsg)}
              </div>
              {" "}
              <div style={{ alignSelf: "flex-end", maxWidth: "85%", background: "var(--wa-out,#d9fdd3)", padding: "6px 9px", fontSize: "14px" }}>
                <div style={{ fontSize: "12px", fontWeight: "600", color: "var(--wa-dark,#008069)" }}>
                  {I($v.persona)}{" · "}{I($v.bizName)}
                </div>
                {I($v.preview)}
              </div>
              {" "}
            </div>
            {" "}
            <span style={{ fontSize: "12px", color: "var(--color-neutral-700)" }}>
              {I($v.persona)}{" always says she’s "}{I($v.bizName)}{"’s assistant and never claims to be a person."}
            </span>
            {" "}
          </div>
          {" "}
        </section>
        {" "}
        <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {" "}
          <h2 style={{ margin: "0", fontSize: "13px", letterSpacing: ".08em", textTransform: "uppercase", borderBottom: "2px solid var(--color-text)", paddingBottom: "8px" }}>
            Business hours
          </h2>
          {" "}
          <span style={{ fontSize: "14px" }}>
            Your hours are set in Booking setup, and that is the only place they are edited.{" "}
            <Link href="/dashboard/settings/booking" data-testid="agent-hours-link" style={{ fontWeight: "600" }}>
              Edit business hours
            </Link>
          </span>
          {" "}
          <span style={{ fontSize: "13px", color: "var(--color-neutral-700)" }}>
            Outside these hours {I($v.persona)} still replies and books visits for the next open slot.
          </span>
          {" "}
        </section>
        {" "}
        <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {" "}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "2px solid var(--color-text)", paddingBottom: "8px", gap: "12px", flexWrap: "wrap" }}>
            {" "}
            <h2 style={{ margin: "0", fontSize: "13px", letterSpacing: ".08em", textTransform: "uppercase" }}>
              Qualification questions
            </h2>
            {" "}
            <span style={{ fontSize: "12px", fontWeight: "600", color: `${$v.weightColor ?? ""}` } as React.CSSProperties}>
              {"Weights add up to "}{I($v.weightTotal)}{" of 100"}
            </span>
            {" "}
          </div>
          {" "}
          {L($v.criteria).map((c: any, $index: number) => (
            <Fragment key={$index}>
              {" "}
              <div style={{ display: "grid", gridTemplateColumns: `${$v.critCols ?? ""}`, gap: "8px 20px", alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--color-divider)" } as React.CSSProperties}>
                {" "}
                <div>
                  <div style={{ fontWeight: "600", fontSize: "15px" }}>
                    {I(c?.name)}
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--color-neutral-700)" }}>
                    {"Full points when: "}{I(c?.rule)}
                  </div>
                </div>
                {" "}
                <input type="range" min="0" max="50" step="5" value={c?.w ?? ""} onChange={c?.set} aria-label={`${c?.name ?? ""} weight`} style={{ width: "100%", accentColor: "var(--color-accent)" }} />
                {" "}
                <span style={{ fontWeight: "800", fontSize: "18px", textAlign: "right" }}>
                  {I(c?.w)}
                </span>
                {" "}
              </div>
              {" "}
            </Fragment>
          ))}
          {" "}
          <div style={{ display: "grid", gridTemplateColumns: `${$v.twoCol ?? ""}`, gap: "16px", marginTop: "8px" } as React.CSSProperties}>
            {" "}
            <div style={{ background: "var(--color-surface)", padding: "14px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {" "}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: "800" }}>
                  Hot from
                </span>
                <span style={{ fontWeight: "800", fontSize: "20px", color: "var(--color-accent-700)" }}>
                  {I($v.hot)}
                </span>
              </div>
              {" "}
              <input type="range" min="50" max="95" step="5" value={$v.hot ?? ""} onChange={$v.setHot} aria-label="Hot threshold" style={{ accentColor: "var(--color-accent)" }} />
              {" "}
              <span style={{ fontSize: "12px", color: "var(--color-neutral-700)" }}>
                Offer a visit now and alert sales
              </span>
              {" "}
            </div>
            {" "}
            <div style={{ background: "var(--color-surface)", padding: "14px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {" "}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: "800" }}>
                  Warm from
                </span>
                <span style={{ fontWeight: "800", fontSize: "20px" }}>
                  {I($v.warm)}
                </span>
              </div>
              {" "}
              <input type="range" min="10" max="65" step="5" value={$v.warm ?? ""} onChange={$v.setWarm} aria-label="Warm threshold" style={{ accentColor: "var(--color-accent)" }} />
              {" "}
              <span style={{ fontSize: "12px", color: "var(--color-neutral-700)" }}>
                Offer a visit and follow up. Below this is Cold.
              </span>
              {" "}
            </div>
            {" "}
          </div>
          {" "}
          <div style={{ display: "flex", height: "12px", marginTop: "4px" }}>
            {" "}
            <span style={{ width: `${$v.coldPct ?? ""}`, background: "var(--color-neutral-300)" } as React.CSSProperties}></span>
            <span style={{ width: `${$v.warmPct ?? ""}`, background: "var(--color-accent-200)" } as React.CSSProperties}></span>
            <span style={{ flex: "1", background: "var(--color-accent-600)" }}></span>
            {" "}
          </div>
          {" "}
        </section>
        {" "}
        <section style={{ display: "flex", flexDirection: "column" }}>
          {" "}
          <h2 style={{ margin: "0", fontSize: "13px", letterSpacing: ".08em", textTransform: "uppercase", borderBottom: "2px solid var(--color-text)", paddingBottom: "8px" }}>
            Hand over to your team when
          </h2>
          {" "}
          {L($v.triggers).map((t: any, $index: number) => (
            <Fragment key={$index}>
              {" "}
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: "16px", alignItems: "center", padding: "12px 0", borderBottom: "1px solid var(--color-divider)" }}>
                {" "}
                <div>
                  <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: "600", fontSize: "15px" }}>
                      {I(t?.name)}
                    </span>
                    {t?.high ? (
                      <>
                        <span style={{ fontSize: "10px", fontWeight: "800", letterSpacing: ".06em", textTransform: "uppercase", padding: "2px 6px", border: "1px solid var(--color-accent)", color: "var(--color-accent-700)" }}>
                          High priority
                        </span>
                      </>
                    ) : null}
                  </div>
                  <div style={{ fontSize: "13px", color: "var(--color-neutral-700)" }}>
                    {I(t?.ex)}
                  </div>
                </div>
                {" "}
                <button onClick={t?.flip} role="switch" aria-checked={t?.on} aria-label={t?.name} style={{ width: "48px", height: "28px", border: `2px solid ${t?.bd ?? ""}`, background: `${t?.tbg ?? ""}`, position: "relative", padding: "0", cursor: "pointer" } as React.CSSProperties}>
                  <span style={{ position: "absolute", top: "2px", left: `${t?.kl ?? ""}`, width: "20px", height: "20px", background: `${t?.kb ?? ""}`, transition: "left .15s" } as React.CSSProperties}></span>
                </button>
                {" "}
              </div>
              {" "}
            </Fragment>
          ))}
          {" "}
          <span data-testid="agent-always-on" style={{ fontSize: "13px", color: "var(--color-neutral-700)", paddingTop: "10px" }}>
            Some handovers always happen and can’t be switched off: when {I($v.persona)} is stuck, when credits run out, and when a customer opts out.
          </span>
        </section>
        {" "}
        <section style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {" "}
          <h2 style={{ margin: "0", fontSize: "13px", letterSpacing: ".08em", textTransform: "uppercase", borderBottom: "2px solid var(--color-text)", paddingBottom: "8px" }}>
            How staff take over
          </h2>
          {" "}
          <div style={{ display: "grid", gridTemplateColumns: `${$v.threeCol ?? ""}`, gap: "12px" } as React.CSSProperties}>
            {" "}
            {L($v.modes).map((md: any, $index: number) => (
              <Fragment key={$index}>
                {" "}
                <button onClick={md?.pick} style={{ display: "flex", flexDirection: "column", gap: "6px", textAlign: "left", padding: "16px", border: `2px solid ${md?.bd ?? ""}`, background: `${md?.bg ?? ""}`, color: "var(--color-text)", font: "inherit", cursor: "pointer" } as React.CSSProperties}>
                  {" "}
                  <span style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                    <span style={{ width: "16px", height: "16px", border: `2px solid ${md?.bd ?? ""}`, display: "grid", placeItems: "center" } as React.CSSProperties}>
                      <span style={{ width: "8px", height: "8px", background: `${md?.dot ?? ""}` } as React.CSSProperties}></span>
                    </span>
                    <span style={{ fontWeight: "800", fontSize: "15px" }}>
                      {I(md?.name)}
                    </span>
                  </span>
                  {" "}
                  <span style={{ fontSize: "13px", color: "var(--color-neutral-700)", lineHeight: "1.4" }}>
                    {I(md?.desc)}
                  </span>
                  {" "}
                </button>
                {" "}
              </Fragment>
            ))}
            {" "}
          </div>
          {" "}
          <span style={{ fontSize: "13px", color: "var(--color-neutral-700)" }}>
            Each staff member can change this for themselves in Team.
          </span>
          {" "}
        </section>
        {" "}
        <div style={{ position: "sticky", bottom: "0", display: "flex", gap: "10px", alignItems: "center", padding: "14px 0", background: "var(--color-bg)", borderTop: "2px solid var(--color-text)" }}>
          {" "}
          <button className="btn btn-primary" disabled aria-disabled="true" data-testid="agent-save">
            Save changes
          </button>
          {" "}
          <span style={{ fontSize: "13px", color: "var(--color-neutral-700)" }}>
            {I($v.saveNote)}
          </span>
          {" "}
        </div>
      </div>
    </>
  );
}

const PakkaAgent = createDC("Pakka Agent", PakkaAgentLogic, renderPakkaAgent);
export default PakkaAgent;
