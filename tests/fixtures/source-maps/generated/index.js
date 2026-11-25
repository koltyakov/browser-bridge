"use strict";(()=>{function n(r){if(r.total<0)throw new Error(`alpha: negative total for ${r.id}`);return r.total}function e(r,t){return n({id:r,total:t})}globalThis.alphaSubmit=e;})();

"use strict";(()=>{function t(n){let r=Number.parseInt(n,10);if(Number.isNaN(r))throw new RangeError(`beta: not a quantity: ${n}`);return r}globalThis.betaParse=t;})();

//# sourceMappingURL=index.js.map
