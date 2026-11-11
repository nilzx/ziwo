// The files of page/ reach the Worker as text (the Text rule in
// wrangler.jsonc): it serves them and never runs them.
declare module "../page/*" {
  const text: string;
  export default text;
}
