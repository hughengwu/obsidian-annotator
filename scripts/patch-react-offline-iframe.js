/**
 * Patches react-offline-iframe to fix iOS WKWebView compatibility issues.
 *
 * Patch 1: doc.open() — remove two-argument form.
 *   The two-argument form `doc.open('text/html', 'replace')` was removed from
 *   the HTML spec and throws TypeError on iOS Safari 15+. Use no-argument form.
 *
 * Patch 2: patchXmlScriptTags blob: inlining — iOS WKWebView fix.
 *   WKWebView blocks <script src="blob:...">. When resource URLs are blob: URLs
 *   (as created by URL.createObjectURL in resourcesFolder.tsx), scripts simply
 *   never execute on iOS. Fix: fetch the blob content and inline the script.
 *
 * Patch 3: Direct outer iframe approach — iOS WKWebView fix.
 *   react-offline-iframe normally writes a wrapper iframe containing a nested
 *   <iframe patched-src="url"> and then patches the inner iframe. This double
 *   document.write() nesting is unreliable on iOS WKWebView. Instead, directly
 *   fetch the src HTML, patch it, and write it into the outer iframe. Also applies
 *   all iframe patches AFTER setIframeContent so doc.open() property resets on iOS
 *   do not lose the patches.
 */
const fs = require('fs');

const files = [
    'node_modules/react-offline-iframe/build/index.js',
    'node_modules/react-offline-iframe/build/index.esm.js'
];

const PATCH_SCRIPT_TAGS_OLD =
`    function patchXmlScriptTags(xmlDoc, contextUrl) {
        for (const tag of xmlDoc.getElementsByTagName('script')) {
            const src = tag.getAttribute('src');
            if (src) {
                tag.setAttribute('src', getResourceUrl(src, contextUrl));
                tag.setAttribute('patched-src', src);
            }
        }
    }`;

const PATCH_SCRIPT_TAGS_NEW =
`    function patchXmlScriptTags(xmlDoc, contextUrl) {
        // iOS WKWebView does not support <script src="blob:...">; inline blob: script content instead.
        const promises = [];
        for (const tag of xmlDoc.getElementsByTagName('script')) {
            const src = tag.getAttribute('src');
            if (src) {
                const resourceUrl = getResourceUrl(src, contextUrl);
                tag.setAttribute('patched-src', src);
                if (resourceUrl && resourceUrl.startsWith('blob:')) {
                    promises.push(fetch(resourceUrl).then(function(r){return r.text();}).then(function(content){
                        tag.removeAttribute('src');
                        tag.textContent = content.replace(/<\\/script>/gi, '<\\\\/script>');
                    }).catch(function(){ tag.setAttribute('src', resourceUrl); }));
                } else {
                    tag.setAttribute('src', resourceUrl);
                }
            }
        }
        return Promise.all(promises);
    }`;

// Patch 3 OLD: original nested-iframe useEffect (React.useEffect variant for index.js)
const USE_EFFECT_OLD_CJS =
`    React.useEffect(() => {
        const iframe = frame.current;
        if (!frame.current)
            return;
        setIframeContentAndPatch(iframe, \`<style>body{margin:0px;}</style><iframe patched-src="\${props.src}" width="100%" height="100%" allowfullscreen="allowfullscreen" frameborder="0">\`);
        if (props.onload) {
            props.onload(iframe.contentDocument.body.firstChild);
        }
        return () => {
            // frame.current?.remove();
        };
    }, [frame]);`;

// Patch 3 NEW: direct outer iframe approach (React.useEffect variant for index.js)
const USE_EFFECT_NEW_CJS =
`    React.useEffect(() => {
        const iframe = frame.current;
        if (!frame.current)
            return;
        // Direct approach: fetch and patch the src HTML directly into the outer iframe.
        // Avoids nested document.write() (outer iframe containing a second iframe), which
        // is unreliable on iOS WKWebView. Also patches the iframe AFTER setIframeContent
        // so that doc.open() resetting window properties on iOS does not lose our patches.
        __awaiter(void 0, void 0, void 0, function* () {
            try {
                const src = props.src;
                const newSrc = proxySrc(src);
                const content = yield (yield fetchUrlContent(newSrc, {
                    headers: {
                        Accept: \`text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8\`,
                        'Accept-Encoding': \`gzip, deflate, br\`
                    }
                })).text();
                const { html, context } = yield patchHtmlCode(content, src);
                setIframeContent(iframe, html);
                // Apply all patches AFTER setIframeContent so that if doc.open() resets
                // window properties on iOS, our patches are still in effect when JS runs.
                patchIframeTags(iframe, context);
                patchIframeEventListeners(iframe, context);
                patchIframeClasses(iframe);
                patchIframePostMessage(iframe);
                patchIframeFetch(iframe, context);
                patchIframeConsole(iframe);
                patchIframeWorker(iframe, context);
                patchIframeXMLHttpRequest(iframe, context);
                patchIframeWebSocket(iframe);
                addIframeMutationObserverWhenReady(iframe);
                iframe.setAttribute('patched', 'true');
                yield props.onIframePatch(iframe);
                if (props.onload) {
                    props.onload(iframe);
                }
            } catch(e) {
                // ignore
            }
        });
        return () => {
            // frame.current?.remove();
        };
    }, [frame]);`;

// Patch 3 OLD: original nested-iframe useEffect (useEffect variant for index.esm.js)
const USE_EFFECT_OLD_ESM =
`    useEffect(() => {
        const iframe = frame.current;
        if (!frame.current)
            return;
        setIframeContentAndPatch(iframe, \`<style>body{margin:0px;}</style><iframe patched-src="\${props.src}" width="100%" height="100%" allowfullscreen="allowfullscreen" frameborder="0">\`);
        if (props.onload) {
            props.onload(iframe.contentDocument.body.firstChild);
        }
        return () => {
            // frame.current?.remove();
        };
    }, [frame]);`;

// Patch 3 NEW: direct outer iframe approach (useEffect variant for index.esm.js)
const USE_EFFECT_NEW_ESM =
`    useEffect(() => {
        const iframe = frame.current;
        if (!frame.current)
            return;
        // Direct approach: fetch and patch the src HTML directly into the outer iframe.
        // Avoids nested document.write() (outer iframe containing a second iframe), which
        // is unreliable on iOS WKWebView. Also patches the iframe AFTER setIframeContent
        // so that doc.open() resetting window properties on iOS does not lose our patches.
        __awaiter(void 0, void 0, void 0, function* () {
            try {
                const src = props.src;
                const newSrc = proxySrc(src);
                const content = yield (yield fetchUrlContent(newSrc, {
                    headers: {
                        Accept: \`text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8\`,
                        'Accept-Encoding': \`gzip, deflate, br\`
                    }
                })).text();
                const { html, context } = yield patchHtmlCode(content, src);
                setIframeContent(iframe, html);
                // Apply all patches AFTER setIframeContent so that if doc.open() resets
                // window properties on iOS, our patches are still in effect when JS runs.
                patchIframeTags(iframe, context);
                patchIframeEventListeners(iframe, context);
                patchIframeClasses(iframe);
                patchIframePostMessage(iframe);
                patchIframeFetch(iframe, context);
                patchIframeConsole(iframe);
                patchIframeWorker(iframe, context);
                patchIframeXMLHttpRequest(iframe, context);
                patchIframeWebSocket(iframe);
                addIframeMutationObserverWhenReady(iframe);
                iframe.setAttribute('patched', 'true');
                yield props.onIframePatch(iframe);
                if (props.onload) {
                    props.onload(iframe);
                }
            } catch(e) {
                // ignore
            }
        });
        return () => {
            // frame.current?.remove();
        };
    }, [frame]);`;

files.forEach(f => {
    try {
        let c = fs.readFileSync(f, 'utf8');

        // Patch 1: doc.open() fix
        c = c.replace(/doc\.open\(['"]text\/html['"],\s*['"]replace['"]\)/g, 'doc.open()');

        // Patch 2: patchXmlScriptTags blob: inlining
        if (c.includes(PATCH_SCRIPT_TAGS_OLD)) {
            c = c.replace(PATCH_SCRIPT_TAGS_OLD, PATCH_SCRIPT_TAGS_NEW);
            // Make patchHtmlCode await the async patchXmlScriptTags
            c = c.replace(
                'patchXmlScriptTags(xmlDoc, contextUrl);\n            patchXmlIframeTags',
                'yield patchXmlScriptTags(xmlDoc, contextUrl);\n            patchXmlIframeTags'
            );
        }

        // Patch 3: Direct outer iframe approach
        const isCjs = f.endsWith('index.js');
        const USE_EFFECT_OLD = isCjs ? USE_EFFECT_OLD_CJS : USE_EFFECT_OLD_ESM;
        const USE_EFFECT_NEW = isCjs ? USE_EFFECT_NEW_CJS : USE_EFFECT_NEW_ESM;
        if (c.includes(USE_EFFECT_OLD)) {
            c = c.replace(USE_EFFECT_OLD, USE_EFFECT_NEW);
            console.log(`  Patch 3 applied to ${f}`);
        } else {
            console.warn(`  Patch 3 OLD string not found in ${f} (may already be patched)`);
        }

        fs.writeFileSync(f, c);
        console.log(`Patched: ${f}`);
    } catch (e) {
        console.warn(`Could not patch ${f}:`, e.message);
    }
});
