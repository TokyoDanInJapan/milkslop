/// <reference types="vite/client" />

declare module "*.milk?raw" {
  const content: string;
  export default content;
}

declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "*.yaml" {
  const data: unknown;
  export default data;
}
