/** CSS Modules type shim (the tsdown client bundle compiles *.module.css). */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
