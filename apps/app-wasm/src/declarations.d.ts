// This is needed to allow for a WASM file to be imported as a module
declare module "*.wasm" {
  const value: string;
  export default value;
}
