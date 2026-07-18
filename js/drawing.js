// ============================================================
// drawing.js â€” Custom Drawing Engine Overlay
// ============================================================

export class DrawingManager {
  /**
   * @param {object}  chart       - lightweight-charts instance
   * @param {object}  priceSeries - the candlestick/line series
   * @param {Element} chartArea   - the .chart-area DOM element
   */
  constructor(chart, priceSeries, chartArea) {
    this.chart = chart;
    this.series = priceSeries;
    this.chartArea = chartArea;

    this.activeTool = "cursor";
    this.drawings = []; // completed drawings
    this.currentDrawing = null; // in-progress drawing
    this.isDrawing = false;
    this.drawingStep = 0; // multi-step state machine (e.g., for sltp)
    this._rafId = 0; // rAF throttle

    // Interactive state
    this.selectedShape = null;
    this.hoverState = null; // { shape, type: 'handle'|'body', index: -1 }
    this.dragState = null; // { shape, type, index?, startX, startY, startPoints }
    this.crosshairPos = null; // { x, y }

    this._onClearCallback = null;
    this._onChangeCallback = null;
    this._onDrawEndCallback = null;

    this._initCanvas();
    this._bindEvents();

    // Trigger redraw throttled by rAF
    const triggerRedraw = () => {
      if (this._rafId) return;
      this._rafId = requestAnimationFrame(() => {
        this._rafId = 0;
        this.redraw();
      });
    };

    // Horizontal pan/zoom
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(triggerRedraw);

    // Vertical pan/zoom (since lightweight-charts has no priceScale event)
    this.chartArea.addEventListener("wheel", triggerRedraw, { passive: true });
    this.chartArea.addEventListener("pointermove", triggerRedraw, {
      passive: true,
    });
    this.chartArea.addEventListener("pointerdown", triggerRedraw, {
      passive: true,
    });
  }

  // â”€â”€ Canvas â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _initCanvas() {
    const c = document.createElement("canvas");
    c.id = "drawing-canvas";
    c.style.cssText =
      "position:absolute;inset:0;pointer-events:none;z-index:10;touch-action:none;";
    this.chartArea.appendChild(c);
    this.canvas = c;
    this.ctx = c.getContext("2d");
  }

  // â”€â”€ Tool selection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  setTool(tool) {
    if (tool === "clear") {
      this.drawings = [];
      this.redraw();
      this.activeTool = "cursor";
      this.canvas.style.pointerEvents = "none";
      this.canvas.style.cursor = "default";
      if (this._onClearCallback) this._onClearCallback();
      this._fireChange();
      return;
    }

    this.activeTool = tool;
    const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    
    if (tool === "cursor" || isMobile) {
      this.canvas.style.pointerEvents = "none";
      this.canvas.style.cursor = tool === "cursor" ? "default" : "crosshair";
    } else {
      this.canvas.style.pointerEvents = "auto";
      this.canvas.style.cursor = "crosshair";
    }
    
    this.selectedShape = null;
    this.isDrawing = false;
    this.currentDrawing = null;
    this.drawingStep = 0;
    this.crosshairPos = null;
    this.redraw();
  }

  onClear(cb) {
    this._onClearCallback = cb;
  }

  onChange(cb) {
    this._onChangeCallback = cb;
  }

  onDrawEnd(cb) {
    this._onDrawEndCallback = cb;
  }

  _fireChange() {
    if (this._onChangeCallback) this._onChangeCallback(this.drawings);
  }

  _fireDrawEnd() {
    if (this._onDrawEndCallback) this._onDrawEndCallback();
  }

  loadDrawings(drawingsArray) {
    this.drawings = Array.isArray(drawingsArray) ? drawingsArray : [];
    this.selectedShape = null;
    this.redraw();
  }

  getDrawings() {
    return this.drawings;
  }

  // â”€â”€ Coordinates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _xToTime(x) {
    let t = this.chart.timeScale().coordinateToTime(x);
    if (t !== null) return t;
    
    const logical = this.chart.timeScale().coordinateToLogical(x);
    if (logical === null) return null;
    
    const data = this.series.data();
    if (data.length < 2) return null;
    
    const lastIdx = data.length - 1;
    const interval = data[lastIdx].time - data[lastIdx - 1].time;
    
    if (logical > lastIdx) {
      return data[lastIdx].time + Math.round(logical - lastIdx) * interval;
    } else if (logical < 0) {
      return data[0].time + Math.round(logical) * interval;
    }
    return null;
  }

  _timeToX(time) {
    let x = this.chart.timeScale().timeToCoordinate(time);
    if (x !== null) return x;

    const data = this.series.data();
    if (data.length < 2) return null;

    const lastIdx = data.length - 1;
    const interval = data[lastIdx].time - data[lastIdx - 1].time;
    
    if (time > data[lastIdx].time) {
      const logical = lastIdx + (time - data[lastIdx].time) / interval;
      return this.chart.timeScale().logicalToCoordinate(logical);
    } else if (time < data[0].time) {
      const logical = (time - data[0].time) / interval;
      return this.chart.timeScale().logicalToCoordinate(logical);
    }
    return null;
  }

  _getCoords(e) {
    const rect = this.chartArea.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = this._xToTime(x);
    const price = this.series.coordinateToPrice(y);
    return { time, price, x, y };
  }

  _toPx(p) {
    const x = this._timeToX(p.time);
    const y = this.series.priceToCoordinate(p.price);
    if (x === null || y === null) return null;
    return { x, y };
  }

  // â”€â”€ Events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _bindEvents() {
    this._bindDrawingEvents();
    this._bindCursorEvents();
    
    // Aggressive mobile scroll prevention while dragging/drawing
    this.chartArea.addEventListener("touchmove", (e) => {
      if (this.dragState) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  _bindCursorEvents() {
    // These run on the chartArea to intercept events when activeTool === 'cursor'

    this.chartArea.addEventListener("pointermove", (e) => {
      if (this.activeTool !== "cursor") return;
      
      // If it's a touch device and we're not actively dragging a shape, 
      // do not steal pointerEvents. This allows normal panning.
      if (e.pointerType === "touch" && !this.dragState) {
        this.hoverState = null;
        this.canvas.style.pointerEvents = "none";
        this.redraw();
        return;
      }

      const { x, y, time, price } = this._getCoords(e);

      // Handle dragging
      if (this.dragState) {
        e.preventDefault();
        e.stopPropagation(); // prevent chart crosshair/pan

        if (time === null || price === null) return;

        const shape = this.dragState.shape;

        if (this.dragState.type === "handle") {
          // Dragging a single vertex
          if (shape.type === "horizontal") {
            // Horizontal line only changes price
            shape.points[0].price = price;
          } else if (shape.type === "sltp") {
            if (this.dragState.index === 0) {
              shape.points[0] = { time, price }; // Move entry freely
            } else if (this.dragState.index === 1) {
              shape.points[1] = { time, price }; // Move TP freely
            } else if (this.dragState.index === 2) {
              shape.points[2] = { time: shape.points[1].time, price }; // Move SL (lock X)
            }
          } else {
            shape.points[this.dragState.index] = { time, price };
          }
        } else if (this.dragState.type === "body") {
          // Dragging entire shape
          const dxPx = x - this.dragState.startX;
          const dyPx = y - this.dragState.startY;

          shape.points = this.dragState.startPoints.map((p) => {
            const origPx = this._toPx(p);
            if (!origPx) return p;
            const newTime = this._xToTime(origPx.x + dxPx);
            const newPrice = this.series.coordinateToPrice(origPx.y + dyPx);
            return { time: newTime ?? p.time, price: newPrice ?? p.price };
          });
        }

        this.redraw();
        return;
      }

      // Handle hovering (when not dragging)
      const hit = this._hitTest(x, y);
      if (hit) {
        this.hoverState = hit;
        this.canvas.style.pointerEvents = "auto"; // Steal pointer events so we can click it
        this.canvas.style.cursor = hit.type === "handle" ? "grab" : "pointer";
      } else {
        this.hoverState = null;
        this.canvas.style.pointerEvents = "none"; // Give pointer back to chart
        this.canvas.style.cursor = "default";
      }
      this.redraw(); // Redraw to highlight hover if needed
    }, { capture: true });

    this.chartArea.addEventListener(
      "pointerdown",
      (e) => {
        if (this.activeTool !== "cursor" || e.button !== 0) return;

        const { x, y } = this._getCoords(e);
        const hit = this._hitTest(x, y);

        if (hit) {
          e.preventDefault();
          e.stopPropagation(); // prevent chart pan
          this.selectedShape = hit.shape;
          this.dragState = {
            shape: hit.shape,
            type: hit.type,
            index: hit.index,
            startX: x,
            startY: y,
            startPoints: JSON.parse(JSON.stringify(hit.shape.points)), // deep clone for body drag reference
          };
          this.canvas.style.cursor = "grabbing";
          this.redraw();
        } else {
          // Clicked empty space -> deselect
          if (this.selectedShape) {
            this.selectedShape = null;
            this.redraw();
          }
        }
      },
      { capture: true },
    ); // Capture phase so we intercept before lightweight-charts starts panning

    this.chartArea.addEventListener("pointerup", (e) => {
      if (this.activeTool !== "cursor") return;
      if (this.dragState) {
        this.dragState = null;
        this.canvas.style.cursor = this.hoverState
          ? this.hoverState.type === "handle"
            ? "grab"
            : "pointer"
          : "default";
        this.redraw();
        this._fireChange();
      }
    }, { capture: true });

    // Keyboard delete
    document.addEventListener("keydown", (e) => {
      if (
        this.activeTool === "cursor" &&
        this.selectedShape &&
        (e.key === "Delete" || e.key === "Backspace")
      ) {
        this.drawings = this.drawings.filter((d) => d !== this.selectedShape);
        this.selectedShape = null;
        this.redraw();
        this._fireChange();
      }
    });
  }

  _bindDrawingEvents() {
    const isMobile = () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

    // --- MOBILE: Center Crosshair Tap-to-Place Logic ---
    let mobileTouchStartX = 0;
    let mobileTouchStartY = 0;
    
    this.chartArea.addEventListener("pointerdown", (e) => {
      if (!isMobile() || this.activeTool === "cursor") return;
      mobileTouchStartX = e.clientX;
      mobileTouchStartY = e.clientY;
    }, { capture: true });

    this.chartArea.addEventListener("pointerup", (e) => {
      if (!isMobile() || this.activeTool === "cursor") return;
      
      const dist = Math.hypot(e.clientX - mobileTouchStartX, e.clientY - mobileTouchStartY);
      if (dist > 10) return; // Ignore drag gestures (panning)

      const W = this.chartArea.offsetWidth;
      const H = this.chartArea.offsetHeight;
      const time = this._xToTime(W / 2);
      const price = this.series.coordinateToPrice(H / 2);
      if (time === null || price === null) return;

      if (!this.isDrawing) {
        this.isDrawing = true;
        this.drawingStep = 1;
        this.currentDrawing = {
          type: this.activeTool,
          points: (this.activeTool === "sltp") ? 
            [{time, price}, {time, price}, {time, price}] :
            [{time, price}]
        };
      } else {
        const pts = this.currentDrawing.points;
        if (this.activeTool === "sltp") {
          if (this.drawingStep === 1) {
            this.drawingStep = 2; // proceed to SL
          } else if (this.drawingStep === 2) {
            this.isDrawing = false;
            this.drawingStep = 0;
            this.drawings.push(this.currentDrawing);
            this.currentDrawing = null;
            this._fireChange();
            this._fireDrawEnd();
          }
        } else if (this.activeTool === "path") {
           pts.push({ time, price }); // path adds points on click
        } else if (this.activeTool === "horizontal") {
           this.isDrawing = false;
           this.drawings.push(this.currentDrawing);
           this.currentDrawing = null;
           this._fireChange();
           this._fireDrawEnd();
        } else {
           // Finish standard 2-point shapes
           this.isDrawing = false;
           this.drawings.push(this.currentDrawing);
           this.currentDrawing = null;
           this._fireChange();
           this._fireDrawEnd();
        }
      }
      this.redraw();
    });

    // --- MOBILE: Live Preview while panning ---
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      if (isMobile() && this.activeTool !== "cursor" && this.isDrawing && this.currentDrawing) {
        const W = this.chartArea.offsetWidth;
        const H = this.chartArea.offsetHeight;
        const time = this._xToTime(W / 2);
        const price = this.series.coordinateToPrice(H / 2);
        
        if (time !== null && price !== null) {
          const pts = this.currentDrawing.points;
          if (this.activeTool === "sltp") {
             if (this.drawingStep === 1) {
                pts[1] = { time, price };
                const diff = price - pts[0].price;
                pts[2] = { time, price: pts[0].price - diff };
             } else if (this.drawingStep === 2) {
                pts[2] = { time: pts[1].time, price };
             }
          } else if (this.activeTool === "horizontal") {
             pts[0] = { time: pts[0].time, price };
          } else if (this.activeTool !== "path") {
             if (pts.length === 1) pts.push({ time, price });
             else pts[pts.length - 1] = { time, price };
          }
        }
        if (!this._rafId) {
          this._rafId = requestAnimationFrame(() => {
            this._rafId = 0;
            this.redraw();
          });
        }
      }
    });

    this.canvas.addEventListener("pointerdown", (e) => {
      if (isMobile()) return;
      if (e.button !== 0) return;
      if (this.activeTool === "cursor") return;

      const { time, price } = this._getCoords(e);
      if (time === null || price === null) return;

      // Handle multi-step tools (sltp)
      if (this.activeTool === "sltp") {
        if (!this.isDrawing) {
          // Step 1: Entry click
          this.isDrawing = true;
          this.drawingStep = 1;
          this.currentDrawing = {
            type: "sltp",
            points: [
              { time, price },
              { time, price },
              { time, price },
            ],
          };
        } else if (this.drawingStep === 2) {
          // Step 3: Final click to lock SL
          this.isDrawing = false;
          this.drawings.push(this.currentDrawing);
          this.currentDrawing = null;
          this.drawingStep = 0;
          this.redraw();
          this._fireChange();
          this._fireDrawEnd();
        }
        return;
      }

      // Normal single-drag tools
      this.isDrawing = true;
      this.currentDrawing = {
        type: this.activeTool,
        points: [{ time, price }],
      };
    });

    this.canvas.addEventListener("pointermove", (e) => {
      if (isMobile()) return;
      const { time, price, x, y } = this._getCoords(e);
      this.crosshairPos = { x, y };

      if (this.isDrawing && this.currentDrawing) {
        if (time !== null && price !== null) {
          const pts = this.currentDrawing.points;

          if (this.activeTool === "path") {
            pts.push({ time, price });
          } else if (this.activeTool === "horizontal") {
            pts[0] = { time: pts[0].time, price };
          } else if (this.activeTool === "sltp") {
            if (this.drawingStep === 1) {
              // Dragging TP: Mirror SL automatically for preview
              pts[1] = { time, price };
              const diff = price - pts[0].price;
              pts[2] = { time, price: pts[0].price - diff };
            } else if (this.drawingStep === 2) {
              // Dragging SL independently (keep X width locked to TP's width)
              pts[2] = { time: pts[1].time, price };
            }
          } else {
            // Two-point tools: trendline, rectangle, measure
            if (pts.length === 1) pts.push({ time, price });
            else pts[pts.length - 1] = { time, price };
          }
        }
      }
      this.redraw();
    });

    this.canvas.addEventListener("pointerup", (e) => {
      if (isMobile() || e.button !== 0 || !this.isDrawing) return;

      if (this.activeTool === "sltp") {
        if (this.drawingStep === 1) {
          // Release TP: Move to Step 2 (adjust SL)
          this.drawingStep = 2;
        }
        return; // Don't cancel drawing yet!
      }

      // Normal tools finish on mouseup
      this.isDrawing = false;

      if (this.currentDrawing) {
        const d = this.currentDrawing;
        if (d.type === "horizontal") {
          this.drawings.push(d);
          this._fireChange();
          this._fireDrawEnd();
        } else if (d.points.length > 1) {
          this.drawings.push(d);
          this._fireChange();
          this._fireDrawEnd();
        }
      }
      this.currentDrawing = null;
      this.redraw();
    });

    this.canvas.addEventListener("pointerleave", () => {
      if (isMobile()) return;
      this.crosshairPos = null;
      if (this.isDrawing) {
        this.isDrawing = false;
        if (this.currentDrawing && this.currentDrawing.points.length > 1) {
          this.drawings.push(this.currentDrawing);
          this._fireChange();
          this._fireDrawEnd();
        }
        this.currentDrawing = null;
        this.drawingStep = 0;
      }
      this.redraw();
    });

    // Right-click delete (legacy wrapper)
    this.chartArea.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (this.isDrawing) {
        this.isDrawing = false;
        this.currentDrawing = null;
        this.redraw();
        return;
      }
      const { x, y } = this._getCoords(e);
      this._deleteAt(x, y);
    });
  }

  // â”€â”€ Hit-test & Interaction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Universal hit test.
   * Returns { shape, type: 'handle'|'body', index } or null.
   */
  _hitTest(mx, my) {
    if (!this.drawings.length) return null;
    const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const T_BODY = isTouch ? 24 : 10;
    const T_HANDLE = isTouch ? 32 : 8; // generous radius for grabbing corners on touch

    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const shape = this.drawings[i];
      const px = shape.points.map((p) => this._toPx(p)).filter(Boolean);
      if (!px.length) continue;

      // 1. Check handles (corners) first (if shape is selected, or if we want handles always hot)
      // Actually, standard behavior is you can grab a handle even if not selected, or only if selected.
      // Let's make handles always grabbable for simplicity, prioritizing them over bodies.
      for (let j = 0; j < px.length; j++) {
        if (Math.hypot(mx - px[j].x, my - px[j].y) <= T_HANDLE) {
          return { shape, type: "handle", index: j };
        }
      }

      // 2. Check body
      let hitBody = false;
      const W = this.chartArea.offsetWidth;

      switch (shape.type) {
        case "horizontal":
          hitBody = Math.abs(my - px[0].y) <= T_BODY;
          break;

        case "trendline":
          if (px.length >= 2)
            hitBody = this._distSeg({ x: mx, y: my }, px[0], px[1]) <= T_BODY;
          break;

        case "rectangle":
        case "measure": {
          if (px.length >= 2) {
            const x0 = Math.min(px[0].x, px[1].x),
              y0 = Math.min(px[0].y, px[1].y);
            const x1 = Math.max(px[0].x, px[1].x),
              y1 = Math.max(px[0].y, px[1].y);
            // Check edges of rectangle (not filled center, so you can click through)
            const onTop = Math.abs(my - y0) <= T_BODY && mx >= x0 && mx <= x1;
            const onBot = Math.abs(my - y1) <= T_BODY && mx >= x0 && mx <= x1;
            const onLeft = Math.abs(mx - x0) <= T_BODY && my >= y0 && my <= y1;
            const onRight = Math.abs(mx - x1) <= T_BODY && my >= y0 && my <= y1;
            hitBody = onTop || onBot || onLeft || onRight;
          }
          break;
        }

        case "sltp": {
          if (px.length >= 2) {
            const entryP = shape.points[0].price;
            const targetP = shape.points[1].price;
            const slPrice =
              shape.points.length > 2
                ? shape.points[2].price
                : entryP - (targetP - entryP);
            const entryY = px[0].y;
            const targetY = px[1].y;
            const slY = this.series.priceToCoordinate(slPrice);

            const x0 = px[0].x;
            const x1 = px[1].x;
            let boxX = Math.min(x0, x1);
            let boxW = Math.abs(x1 - x0);
            if (boxW < 80) {
              boxW = 120;
              boxX = x0;
            }

            if (mx >= boxX - T_BODY && mx <= boxX + boxW + T_BODY) {
              hitBody =
                Math.abs(my - entryY) <= T_BODY ||
                Math.abs(my - targetY) <= T_BODY ||
                (slY !== null && Math.abs(my - slY) <= T_BODY);
            }
          }
          break;
        }

        case "path":
          for (let j = 0; j < px.length - 1; j++) {
            if (this._distSeg({ x: mx, y: my }, px[j], px[j + 1]) <= T_BODY) {
              hitBody = true;
              break;
            }
          }
          break;
      }

      if (hitBody) {
        return { shape, type: "body", index: -1 };
      }
    }
    return null;
  }

  // Right-click delete (legacy wrapper)
  _deleteAt(x, y) {
    const hit = this._hitTest(x, y);
    if (hit) {
      this.drawings = this.drawings.filter((d) => d !== hit.shape);
      if (this.selectedShape === hit.shape) this.selectedShape = null;
      this.redraw();
      this._fireChange();
    }
  }

  _distSeg(p, v, w) {
    const l2 = (w.x - v.x) ** 2 + (w.y - v.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(
      p.x - (v.x + t * (w.x - v.x)),
      p.y - (v.y + t * (w.y - v.y)),
    );
  }

  // â”€â”€ Rendering â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  onResize() {
    this.redraw();
  }

  redraw() {
    const W = this.chartArea.offsetWidth;
    const H = this.chartArea.offsetHeight;
    if (!W || !H) return;

    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.canvas.width = W;
      this.canvas.height = H;
    }

    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);

    try {
      this.drawings.forEach((d) => this._draw(ctx, d, W, H));
      if (this.currentDrawing) this._draw(ctx, this.currentDrawing, W, H);
    } catch (e) {
      console.warn("[Drawing] render error:", e);
    }

    // Draw custom crosshair when a drawing tool is active
    if (this.activeTool !== "cursor") {
      const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
      let cx = null, cy = null;
      
      if (isMobile) {
        cx = W / 2;
        cy = H / 2;
      } else if (this.crosshairPos) {
        cx = this.crosshairPos.x;
        cy = this.crosshairPos.y;
      }

      if (cx !== null && cy !== null) {
        ctx.save();
        ctx.strokeStyle = "rgba(163, 177, 198, 0.5)"; // matching standard crosshair colors
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);

        ctx.beginPath();
        // vertical line
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, H);
        // horizontal line
        ctx.moveTo(0, cy);
        ctx.lineTo(W, cy);
        ctx.stroke();

        ctx.restore();
      }
    }
  }

  _draw(ctx, shape, W, H) {
    const px = shape.points.map((p) => this._toPx(p)).filter(Boolean);
    if (!px.length) return;

    ctx.save();

    switch (shape.type) {
      // â”€â”€ Trendline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case "trendline":
          if (px.length >= 2) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 2;
            
            ctx.beginPath();
            ctx.moveTo(px[0].x, px[0].y);
            ctx.lineTo(px[1].x, px[1].y);
            ctx.stroke();

            // Draw handles
            this._dot(ctx, px[0].x, px[0].y, 3.5, "#ffffff");
            this._dot(ctx, px[1].x, px[1].y, 3.5, "#ffffff");
          }
          break;

      // â”€â”€ Horizontal Line â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case "horizontal":
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(px[0].y) + 0.5);
        ctx.lineTo(W, Math.round(px[0].y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        this._priceBadge(
          ctx,
          W - 8,
          px[0].y,
          shape.points[0].price,
          "#ffffff",
          "right",
        );
        break;

      // â”€â”€ Rectangle (golden) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case "rectangle":
        if (px.length >= 2) {
          const x = Math.min(px[0].x, px[1].x);
          const y = Math.min(px[0].y, px[1].y);
          const w = Math.abs(px[1].x - px[0].x);
          const h = Math.abs(px[1].y - px[0].y);
          ctx.fillStyle = "rgba(255, 215, 0, 0.15)";
          ctx.strokeStyle = "#ffd700";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.rect(x, y, w, h);
          ctx.fill();
          ctx.stroke();

          // Draw handles
          this._dot(ctx, px[0].x, px[0].y, 3.5, "#ffd700");
          this._dot(ctx, px[1].x, px[1].y, 3.5, "#ffd700");
        }
        break;

      // â”€â”€ Path (freehand) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case "path":
        if (px.length >= 2) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(px[0].x, px[0].y);
          for (let i = 1; i < px.length; i++) ctx.lineTo(px[i].x, px[i].y);
          ctx.stroke();
        }
        break;

      // â”€â”€ SL / TP  (TradingView-style Long/Short Position) â”€â”€
      case "sltp":
        if (px.length >= 2) {
          const entryP = shape.points[0].price;
          const targetP = shape.points[1].price;
          const slPrice =
            shape.points.length > 2
              ? shape.points[2].price
              : entryP - (targetP - entryP);

          const isLong = targetP > entryP;

          const entryY = px[0].y;
          const tpY = px[1].y;
          const slPx = this.series.priceToCoordinate(slPrice);
          if (slPx === null) break;
          const slY = slPx;

          const tpPct = ((targetP - entryP) / entryP) * 100;
          const slPct = ((slPrice - entryP) / entryP) * 100;

          // Box horizontal bounds
          const x0 = px[0].x;
          const x1 = px[1].x;
          let boxX = Math.min(x0, x1);
          let boxW = Math.abs(x1 - x0);

          // Enforce minimum width if the user drags straight up/down
          if (boxW < 80) {
            boxW = 120;
            boxX = x0; // anchor to click
          }

          // â”€â”€ Zones â”€â”€
          const tpTop = Math.min(entryY, tpY);
          const tpBot = Math.max(entryY, tpY);
          const slTop = Math.min(entryY, slY);
          const slBot = Math.max(entryY, slY);

          ctx.fillStyle = "rgba(0, 212, 170, 0.15)"; // Green TP zone
          ctx.fillRect(boxX, tpTop, boxW, tpBot - tpTop);

          ctx.fillStyle = "rgba(255, 73, 118, 0.15)"; // Red SL zone
          ctx.fillRect(boxX, slTop, boxW, slBot - slTop);

          // â”€â”€ Border Lines â”€â”€
          const drawLine = (y, color, width, dash = []) => {
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.setLineDash(dash);
            ctx.beginPath();
            ctx.moveTo(boxX, Math.round(y) + 0.5);
            ctx.lineTo(boxX + boxW, Math.round(y) + 0.5);
            ctx.stroke();
            ctx.setLineDash([]);
          };

          drawLine(tpY, "#00d4aa", 2); // TP Edge
          drawLine(slY, "#ff4976", 2); // SL Edge
          drawLine(entryY, "#ffffff", 1.5, [4, 4]); // Entry Line

          // â”€â”€ Text Labels (Centered in zones) â”€â”€
          const centerX = boxX + boxW / 2;
          ctx.textAlign = "center";
          ctx.font = "11px Inter, sans-serif";

          // Target Label
          ctx.fillStyle = "#ffffff";
          const tpText = `Target: ${targetP.toFixed(2)} (${Math.abs(tpPct).toFixed(2)}%)`;
          ctx.fillText(tpText, centerX, tpTop + 14);

          // Stop Label
          const slText = `Stop: ${slPrice.toFixed(2)} (${Math.abs(slPct).toFixed(2)}%)`;
          ctx.fillText(slText, centerX, slBot - 6);

          // R:R / Middle text
          const tpDiff = Math.abs(targetP - entryP);
          const slDiff = Math.abs(slPrice - entryP);
          const rr = slDiff > 0 ? (tpDiff / slDiff).toFixed(2) : "âˆž";
          const midText = `R:R ${rr}  |  Entry: ${entryP.toFixed(2)}`;

          // Draw text slightly offset from the dashed entry line
          ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
          ctx.fillText(midText, centerX, isLong ? entryY + 14 : entryY - 6);
        }
        break;

      // â”€â”€ Measure â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      case "measure":
        if (px.length >= 2) {
          const p1 = shape.points[0],
            p2 = shape.points[1];
          const x = Math.min(px[0].x, px[1].x);
          const y = Math.min(px[0].y, px[1].y);
          const w = Math.abs(px[1].x - px[0].x);
          const h = Math.abs(px[1].y - px[0].y);

          // Box
          ctx.fillStyle = "rgba(74, 158, 255, 0.10)";
          ctx.strokeStyle = "#4a9eff";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(x, y, w, h);
          ctx.fillRect(x, y, w, h);
          ctx.setLineDash([]);

          // Diagonal
          ctx.strokeStyle = "#4a9eff";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px[0].x, px[0].y);
          ctx.lineTo(px[1].x, px[1].y);
          ctx.stroke();

          // Info badge
          const priceD = p2.price - p1.price;
          const pctD = (priceD / p1.price) * 100;
          const sign = priceD >= 0 ? "+" : "";
          const info = `${sign}${priceD.toFixed(2)}  (${sign}${pctD.toFixed(2)}%)`;

          const badgeX = x + w / 2;
          const badgeY = y - 6;
          ctx.font = "11px JetBrains Mono, monospace";
          const tw = ctx.measureText(info).width;
          ctx.fillStyle = "rgba(10, 10, 15, 0.85)";
          ctx.fillRect(badgeX - tw / 2 - 6, badgeY - 13, tw + 12, 18);
          ctx.fillStyle = priceD >= 0 ? "#00d4aa" : "#ff4976";
          ctx.textAlign = "center";
          ctx.fillText(info, badgeX, badgeY);
        }
        break;
    }

    // Draw selection handles if this is the active shape
    if (this.selectedShape === shape) {
      px.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#4a9eff";
        ctx.stroke();
      });
    }

    ctx.restore();
  }

  // â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _dot(ctx, x, y, r, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  _priceBadge(ctx, x, y, price, color, align, label) {
    const priceStr =
      typeof price === "number" ? price.toFixed(2) : String(price);
    const text = label ? `${label}  ${priceStr}` : priceStr;
    ctx.font = "11px JetBrains Mono, monospace";
    const tw = ctx.measureText(text).width;
    const pad = 5,
      bh = 16;
    const bx = align === "right" ? x - tw - pad * 2 : x;
    const by = y - bh / 2;

    ctx.fillStyle = "rgba(10, 10, 15, 0.85)";
    ctx.fillRect(bx, by, tw + pad * 2, bh);
    ctx.fillStyle = color;
    ctx.textAlign = align === "right" ? "right" : "left";
    ctx.fillText(text, align === "right" ? x - pad : x + pad, y + 4);
  }

  // â”€â”€ Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  destroy() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
  }
}
