import * as genericAnnotation from 'defineGenericAnnotation';
import React from 'react';
import { Vault, TFile } from 'obsidian';
import AnnotatorPlugin from 'main';

import { AnnotatorSettings } from 'settings';
import { EpubAnnotationProps } from './types';

import * as epubjs from 'epubjs';
import { SpineItem } from 'epubjs/types/section';
import { PackagingMetadataObject } from 'epubjs/types/packaging';
import Navigation from 'epubjs/types/navigation';

import { wait } from 'utils';
import { SAMPLE_EPUB_URL } from './constants';

export default (vault: Vault, plugin: AnnotatorPlugin) => {
    const GenericAnnotationEpub = genericAnnotation.default(vault, plugin);
    let epubReader: EpubReader | null = null;

    const EpubAnnotation = ({ lastPosition, ...props }: EpubAnnotationProps) => {
        return (
            <GenericAnnotationEpub
                baseSrc="https://cdn.hypothes.is/demos/epub/epub.js/index.html"
                {...props}
                onload={async iframe => {
                    await props.onload?.(iframe);
                    while (iframe?.contentDocument?.body?.innerHTML == '') {
                        await wait(50);
                    }

                    // 清理之前的 reader（含位置保存）
                    if (epubReader) {
                        epubReader.cleanup(epubReader.book);
                    }

                    epubReader = new EpubReader(plugin.settings.epubSettings, plugin, props.annotationFile, lastPosition);
                    iframe.contentDocument.addEventListener('DOMContentLoaded', epubReader.start(iframe), false);

                    // 监听 iframe 卸载，关闭前保存当前位置
                    const originalOnUnload = iframe.contentWindow.onbeforeunload;
                    iframe.contentWindow.onbeforeunload = () => {
                        if (epubReader) {
                            epubReader.cleanup(epubReader.book);
                            epubReader = null;
                        }
                        if (originalOnUnload) originalOnUnload();
                    };
                }}
            />
        );
    };
    return EpubAnnotation;
};

interface readerWindow extends Window {
    rendition?: epubjs.Rendition;
}

// hypothes.is custom event
interface ScrollToRange extends Event {
    detail?: Range;
}

class EpubReader {
    readonly bookUrl: string;
    readonly settings: AnnotatorSettings['epubSettings'];
    readonly readingModes = {
        scroll: { manager: 'continuous', flow: 'scrolled' },
        pagination: { manager: 'default', flow: 'paginated' }
    };
    plugin: AnnotatorPlugin;
    annotationFile: string;
    lastPosition?: string;
    currentPosition?: string;
    savePositionInterval?: number;
    book?: epubjs.Book;

    constructor(
        epubSettings: AnnotatorSettings['epubSettings'],
        plugin: AnnotatorPlugin,
        annotationFile: string,
        lastPosition?: string
    ) {
        this.bookUrl = SAMPLE_EPUB_URL;
        this.settings = epubSettings;
        this.plugin = plugin;
        this.annotationFile = annotationFile;
        this.lastPosition = lastPosition;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    start(iframe: HTMLIFrameElement): any {
        const id = iframe.contentDocument;

        // linter says it's possible that iframe would be null
        // should be fixed in a future
        const iw: readerWindow | null = iframe.contentWindow;

        const book = this.initBook(id, iw);
        this.book = book;

        this.configureNavigationEvents(book, id, this.settings.readingMode);
        this.addBookMetaToUI(book, iframe);
        book.rendition.on('rendered', (section: SpineItem) => this.renderedHook(book, id, section));

        // 如果有上次阅读位置，跳转到该位置
        if (this.lastPosition) {
            book.rendition.display(this.lastPosition);
        } else {
            book.rendition.display();
        }
        book.ready.then(() => this.removeLoader(id));

        // 设置定期保存阅读位置
        this.setupPositionSaving(book);
    }

    setupPositionSaving(book: epubjs.Book) {
        const doSave = (position: string) => {
            if (position && position !== this.currentPosition) {
                this.currentPosition = position;
                const file = this.plugin.app.vault.getAbstractFileByPath(this.annotationFile);
                if (file instanceof TFile) {
                    this.plugin.saveLastPosition(file, position);
                }
            }
        };

        // 页面切换时立即保存：优先用 CFI（精确到段落内位置），回退到 href（章节）
        book.rendition.on('relocated', (location: unknown) => {
            const loc = location as { start?: { cfi?: string; href?: string } };
            const position = loc?.start?.cfi || loc?.start?.href;
            doSave(position);
        });

        // 每 30 秒兜底保存一次
        this.savePositionInterval = window.setInterval(() => {
            const currentLocation = book.rendition.currentLocation() as unknown as {
                start?: { cfi?: string; href?: string };
            };
            const position = currentLocation?.start?.cfi || currentLocation?.start?.href;
            doSave(position);
        }, 30000);
    }

    saveCurrentPosition(book: epubjs.Book) {
        try {
            const loc = book.rendition.currentLocation() as unknown as {
                start?: { cfi?: string; href?: string };
            };
            const position = loc?.start?.cfi || loc?.start?.href;
            if (position) {
                const file = this.plugin.app.vault.getAbstractFileByPath(this.annotationFile);
                if (file instanceof TFile) {
                    this.plugin.saveLastPosition(file, position);
                }
            }
        } catch (e) {
            // rendition 可能已销毁，忽略
        }
    }

    cleanup(book?: epubjs.Book) {
        if (this.savePositionInterval) {
            clearInterval(this.savePositionInterval);
        }
        if (book) {
            this.saveCurrentPosition(book);
        }
    }

    initBook(id: Document, iw: readerWindow): epubjs.Book {
        const book = new epubjs.Book(this.bookUrl, {
            requestMethod: async function (url) {
                return await (await iw.fetch(url)).arrayBuffer();
            },
            canonical: function (path) {
                return iw.location.origin + iw.location.pathname + '?loc=' + path;
            }
        });

        book.renderTo(id.getElementById('viewer'), {
            ...this.readingModes[this.settings.readingMode],
            ignoreClass: 'annotator-hl',
            width: '100%',
            height: '100%',
            allowScriptedContent: true
        });

        book.rendition.themes.fontSize(`${this.settings.fontSize}%`);
        book.rendition.on('relocated', () => {
            book.rendition.themes.fontSize(`${this.settings.fontSize}%`);
        });

        iw.rendition = book.rendition;
        return book;
    }

    renderedHook(book: epubjs.Book, id: Document, section: SpineItem) {
        const current = book.navigation && book.navigation.get(section.href);

        if (current) {
            id.title = current.label;

            // TODO: this is needed to trigger the hypothesis client
            // to inject into the iframe
            requestAnimationFrame(function () {
                id.getElementById('hiddenTitle').textContent = section.href;
            });

            // Add CFI fragment to the history
            history.pushState({}, '', '?loc=' + encodeURIComponent(section.href));

            id.querySelectorAll('.active').forEach(function (link) {
                link.classList.remove('active');
            });

            const active = id.querySelector('a[href="' + section.href + '"]');
            if (active) {
                active.classList.add('active');
            }
        }
    }

    addBookMetaToUI(book: epubjs.Book, iframe: HTMLIFrameElement) {
        // add chapters to table of contents
        book.loaded.navigation
            .then((nav: Navigation): void => {
                const toc = iframe.contentDocument.getElementById('toc'),
                    docfrag = iframe.contentDocument.createDocumentFragment();

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                nav.forEach((chapter: epubjs.NavItem): any => {
                    const item = iframe.contentDocument.createElement('li');
                    const link = iframe.contentDocument.createElement('a');

                    link.id = 'chap-' + chapter.id;
                    link.textContent = chapter.label;
                    link.href = chapter.href;
                    item.appendChild(link);
                    docfrag.appendChild(item);

                    link.onclick = () => {
                        const url = link.getAttribute('href');
                        book.rendition.display(url);
                        return false;
                    };
                });

                toc.appendChild(docfrag);
            })
            .catch(() => {
                throw 'Failed to load book navigation';
            });

        // add title and author to table of contents
        book.loaded.metadata.then(function (meta: PackagingMetadataObject) {
            iframe.contentDocument.getElementById('title').textContent = meta.title;
            iframe.contentDocument.getElementById('author').textContent = meta.creator;
        });

        // add cover to table of contents
        book.loaded.cover.then((cover: string) => {
            const coverImgEl = iframe.contentDocument.getElementById('cover') as HTMLImageElement;

            if (cover) {
                if (book.archive) {
                    book.archive.createUrl(cover, { base64: false }).then(url => {
                        coverImgEl.src = url;
                    });
                } else {
                    coverImgEl.src = cover;
                }
            }
        });

        book.rendition.hooks.content.register(function (contents: epubjs.Contents) {
            contents.window.addEventListener('scrolltorange', function (e: ScrollToRange) {
                if (e.detail === undefined) return;

                const range = e.detail.toString();
                const cfi = new epubjs.EpubCFI(range, contents.cfiBase).toString();

                if (cfi) {
                    book.rendition.display(cfi);
                }
                e.preventDefault();
            });
        });
    }

    configureNavigationEvents(book: epubjs.Book, id: Document, readingMode: 'scroll' | 'pagination') {
        // configure UI arrows
        if (readingMode == 'scroll') {
            id.querySelectorAll('a.arrow').forEach((e: HTMLElement) => (e.style.display = 'none'));
            id.querySelector('#viewer').classList.add('hide-after');
        }

        id.getElementById('next').addEventListener(
            'click',
            function (e: Event) {
                book.rendition.next();
                e.preventDefault();
            },
            false
        );

        id.getElementById('prev').addEventListener(
            'click',
            function (e: Event) {
                book.rendition.prev();
                e.preventDefault();
            },
            false
        );

        // turn pages by arrow buttons
        const keyListener = function (e: KeyboardEvent) {
            // Left Key
            if ((e.keyCode || e.which) == 37) {
                book.rendition.prev();
            }

            // Right Key
            if ((e.keyCode || e.which) == 39) {
                book.rendition.next();
            }
        };

        book.rendition.on('keyup', keyListener);
        id.addEventListener('keyup', keyListener, false);
        // to make keys work even when focus outside of reader iframe
        document.addEventListener('keyup', keyListener, false);

        // open/close table of contents
        const nav = id.getElementById('navigation');

        id.getElementById('opener').addEventListener(
            'click',
            function () {
                nav.classList.add('open');
            },
            false
        );

        id.getElementById('closer').addEventListener(
            'click',
            function () {
                nav.classList.remove('open');
            },
            false
        );
    }

    removeLoader = (id: Document) => {
        id.getElementById('viewer').classList.remove('loading');
    };
}
