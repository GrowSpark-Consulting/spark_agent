// A yes or a no to "shall I cancel your booking?", read in plain code. Nothing is cancelled on a guess: a message that says both
// ("yes, don't cancel"), neither ("what time is it at?"), or something the code cannot tell, is `unclear`, and the assistant asks again.
// English, Tanglish, Tamil script and a little Hindi.

export type YesNo = "yes" | "no" | "unclear";

const MAX_TEXT = 300;
const NO =
  /\b(?:no|nope|nah|nahi|illa|illai|venam|don'?t|do not|dont|keep it|keep my|leave it|never ?mind|not now|not really|no thanks)\b|இல்லை|வேண்டாம்/u;
const YES =
  /\b(?:yes|yeah|yep|yup|sure|ok(?:ay)?|go ahead|cancel (?:it|my|the|this)|please cancel|confirm(?:ed)?|haan|han|aama|aam|seri|sari)\b|^\W*cancel\W*$|ஆமா|ஆம்|சரி/u;

export function readYesNo(raw: string): YesNo {
  const text = raw.slice(0, MAX_TEXT).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  if (!text) return "unclear";
  const no = NO.test(text);
  // "don't cancel it" says no: the cancel in it is not a yes.
  const yes = YES.test(text.replace(/\b(?:don'?t|do not|dont)\s+cancel(?:\s+(?:it|my|the|this))?/g, " "));
  if (no === yes) return "unclear"; // both, or neither
  return yes ? "yes" : "no";
}
