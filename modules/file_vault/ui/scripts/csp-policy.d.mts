/** 类型声明：csp-policy.mjs 是纯 JS（要能被 node 直接加载做测试），
 *  vite.config.ts 在严格模式下需要这份声明才能 import 它。 */
export declare const CSP_PLACEHOLDER: string
export declare function buildCsp(options: { dev: boolean }): string
export declare function injectCsp(html: string, options: { dev: boolean }): string
