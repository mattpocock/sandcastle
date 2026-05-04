/// <reference types="vite/client" />

interface Window {
  readonly sandcastle: {
    readonly port: number;
    readonly token: string;
  };
}

declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
