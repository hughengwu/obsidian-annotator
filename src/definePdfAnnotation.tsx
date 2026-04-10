import defineGenericAnnotation from 'defineGenericAnnotation';
import React from 'react';
import { Vault, TFile } from 'obsidian';
import AnnotatorPlugin from 'main';
import { wait } from 'utils';
import { PdfAnnotationProps } from './types';

export default (vault: Vault, plugin: AnnotatorPlugin) => {
    const GenericAnnotationPdf = defineGenericAnnotation(vault, plugin);
    const PdfAnnotation = ({ lastPosition, onload, ...props }: PdfAnnotationProps) => {
        return (
            <GenericAnnotationPdf
                baseSrc="https://via.hypothes.is/https.html"
                {...props}
                onload={async iframe => {
                    let pdfJsFrame;
                    do {
                        await wait(100);
                        pdfJsFrame = iframe.contentDocument.getElementsByTagName('iframe')[0];
                    } while (
                        pdfJsFrame == null ||
                        !pdfJsFrame.contentDocument?.addEventListener ||
                        !pdfJsFrame.contentWindow?.PDFViewerApplication?.pdfViewer
                    );

                    const document = pdfJsFrame.contentDocument;
                    const { PDFViewerApplication } = pdfJsFrame.contentWindow;

                    // 等待 PDF 加载完成
                    const pdfViewer = PDFViewerApplication.pdfViewer;

                    // 用上次阅读页码初始化 currentPage，防止加载期间的 pagechanging(1) 覆盖已保存位置
                    const targetPage = lastPosition ? (parseInt(lastPosition, 10) || 1) : 1;
                    let currentPage = targetPage;

                    const saveCurrentPage = () => {
                        const file = plugin.app.vault.getAbstractFileByPath(props.annotationFile);
                        if (file instanceof TFile) {
                            plugin.saveLastPosition(file, String(currentPage));
                        }
                    };

                    // 页面变化时立即保存
                    pdfViewer.eventBus.on('pagechanging', (e: { pageNumber: number }) => {
                        if (e.pageNumber !== currentPage) {
                            currentPage = e.pageNumber;
                            saveCurrentPage();
                        }
                    });

                    // 每 30 秒保存一次（保障极端情况）
                    const saveInterval = setInterval(() => {
                        const newPage = PDFViewerApplication.page;
                        if (newPage && newPage !== currentPage) {
                            currentPage = newPage;
                            saveCurrentPage();
                        }
                    }, 30000);

                    // 如果有上次阅读位置，跳转到该页
                    if (lastPosition) {
                        const pageNumber = parseInt(lastPosition, 10);
                        if (!isNaN(pageNumber) && pageNumber > 0) {
                            const checkAndJump = () => {
                                if (pdfViewer.pagesCount > 0) {
                                    PDFViewerApplication.page = pageNumber;
                                    return true;
                                }
                                return false;
                            };

                            if (!checkAndJump()) {
                                const interval = setInterval(() => {
                                    if (checkAndJump()) {
                                        clearInterval(interval);
                                    }
                                }, 500);
                                setTimeout(() => clearInterval(interval), 30000);
                            }
                        }
                    }

                    // 关闭时保存当前位置，确保最新页码不丢失
                    const originalOnUnload = iframe.contentWindow.onbeforeunload;
                    iframe.contentWindow.onbeforeunload = () => {
                        clearInterval(saveInterval);
                        currentPage = PDFViewerApplication.page || currentPage;
                        saveCurrentPage();
                        if (originalOnUnload) originalOnUnload();
                    };

                    let startX = 0,
                        startY = 0;
                    let initialPinchDistance = 0;
                    let pinchScale = 1;
                    const viewer = document.getElementById('viewer');
                    const container = document.getElementById('viewerContainer');
                    const reset = () => {
                        startX = startY = initialPinchDistance = 0;
                        pinchScale = 1;
                    };
                    // Prevent native iOS page zoom
                    //document.addEventListener("touchmove", (e) => { if (e.scale !== 1) { e.preventDefault(); } }, { passive: false });
                    document.addEventListener('touchstart', e => {
                        if (e.touches.length > 1) {
                            startX = (e.touches[0].pageX + e.touches[1].pageX) / 2;
                            startY = (e.touches[0].pageY + e.touches[1].pageY) / 2;
                            initialPinchDistance = Math.hypot(
                                e.touches[1].pageX - e.touches[0].pageX,
                                e.touches[1].pageY - e.touches[0].pageY
                            );
                        } else {
                            initialPinchDistance = 0;
                        }
                    });
                    document.addEventListener(
                        'touchmove',
                        e => {
                            if (initialPinchDistance <= 0 || e.touches.length < 2) {
                                return;
                            }
                            if (e.scale !== 1) {
                                e.preventDefault();
                            }
                            const pinchDistance = Math.hypot(
                                e.touches[1].pageX - e.touches[0].pageX,
                                e.touches[1].pageY - e.touches[0].pageY
                            );
                            const originX = startX + container.scrollLeft;
                            const originY = startY + container.scrollTop;
                            pinchScale = pinchDistance / initialPinchDistance;
                            viewer.style.transform = `scale(${pinchScale})`;
                            viewer.style.transformOrigin = `${originX}px ${originY}px`;
                        },
                        { passive: false }
                    );
                    document.addEventListener('touchend', () => {
                        if (initialPinchDistance <= 0) {
                            return;
                        }
                        viewer.style.transform = `none`;
                        viewer.style.transformOrigin = `unset`;
                        PDFViewerApplication.pdfViewer.currentScale *= pinchScale;
                        const rect = container.getBoundingClientRect();
                        const dx = startX - rect.left;
                        const dy = startY - rect.top;
                        container.scrollLeft += dx * (pinchScale - 1);
                        container.scrollTop += dy * (pinchScale - 1);
                        reset();
                    });
                    await onload(iframe);
                }}
            />
        );
    };
    return PdfAnnotation;
};
