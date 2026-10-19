document.addEventListener('DOMContentLoaded', function() {
    // 1. Initialize MLP Neural Net
    const nnSvg = document.getElementById('nn-svg');
    if (nnSvg) {
        const layers = [6, 8, 8, 4];
        const layerWidth = 53; 
        const nodeSpacing = 9;
        const startX = 20;
        
        // Draw weights first (so they are behind nodes)
        layers.forEach((nodes, lIdx) => {
            if (lIdx < layers.length - 1) {
                const nextNodes = layers[lIdx + 1];
                for (let i = 0; i < nodes; i++) {
                    for (let j = 0; j < nextNodes; j++) {
                        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                        line.setAttribute("x1", startX + lIdx * layerWidth);
                        line.setAttribute("y1", 40 - (nodes - 1) * nodeSpacing / 2 + i * nodeSpacing);
                        line.setAttribute("x2", startX + (lIdx + 1) * layerWidth);
                        line.setAttribute("y2", 40 - (nextNodes - 1) * nodeSpacing / 2 + j * nodeSpacing);
                        line.setAttribute("class", "nn-weight");
                        line.dataset.layer = lIdx;
                        nnSvg.appendChild(line);
                    }
                }
            }
        });

        // Draw nodes
        layers.forEach((nodes, lIdx) => {
            for (let i = 0; i < nodes; i++) {
                const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
                circle.setAttribute("cx", startX + lIdx * layerWidth);
                circle.setAttribute("cy", 40 - (nodes - 1) * nodeSpacing / 2 + i * nodeSpacing);
                circle.setAttribute("r", 2.5);
                circle.setAttribute("class", "nn-node");
                circle.dataset.layer = lIdx;
                nnSvg.appendChild(circle);
            }
        });
    }

    // 2. Initialize Chart.js for Results
    const canvasResults = document.getElementById('canvas-results');
    let resultsChart = null;

    if (canvasResults) {
        resultsChart = new Chart(canvasResults.getContext('2d'), {
            type: 'bar',
            data: {
                labels: [
                    ['workflow.species.blueJay', 'Blue Jay'],
                    ['workflow.species.americanRobin', 'American Robin'],
                    ['workflow.species.houseSparrow', 'House Sparrow']
                ].map(([key, fallback]) => {
                    const translated = window.i18n ? window.i18n.t(key) : key;
                    return translated !== key ? translated : fallback;
                }),
                datasets: [{
                    data: [0, 0, 0],
                    backgroundColor: 'rgba(255, 255, 255, 0.95)',
                    borderRadius: 4,
                    barThickness: 8
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                animation: false, // Smoothness
                plugins: { legend: { display: false } },
                scales: {
                    x: { display: false, max: 1, min: 0 },
                    y: { 
                        ticks: { color: 'rgba(255,255,255,0.9)', font: { size: 9, family: 'monospace' } }, 
                        grid: { display: false },
                        border: { display: false }
                    }
                }
            }
        });
    }

    // 3. Animation State
    const steps = document.querySelectorAll('.step-item');
    const panels = document.querySelectorAll('.viz-panel');
    const descriptions = document.querySelectorAll('.step-desc');
    const progressBar = document.getElementById('viz-progress');
    const waveformPath = document.querySelector('#panel-1 svg path');
    const specCanvas = document.getElementById('canvas-spectrogram-static');
    
    let currentStep = 0;
    const CYCLE_TIME = 3000;
    const DATA_DURATION = 7.0;
    const WINDOW_DURATION = 3.0;
    
    // Get data from global window object
    const peaks = window.BIRDNET_DATA ? window.BIRDNET_DATA.peaks : [];
    const specData = window.BIRDNET_DATA ? window.BIRDNET_DATA.spectrogram : [];

    function updateWaveform(timeOffset) {
        if (!waveformPath || !peaks.length) return;
        const totalPeaks = peaks.length;
        const windowSize = Math.floor(totalPeaks * (WINDOW_DURATION / DATA_DURATION));
        const startIdx = Math.floor(totalPeaks * (timeOffset / DATA_DURATION)) % totalPeaks;
        
        let d = "M0,30";
        for (let i = 0; i < windowSize; i++) {
            const idx = (startIdx + i) % totalPeaks;
            const x = (i / windowSize) * 200;
            const y = 30 - (peaks[idx] * 28);
            d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
        }
        for (let i = windowSize - 1; i >= 0; i--) {
            const idx = (startIdx + i) % totalPeaks;
            const x = (i / windowSize) * 200;
            const y = 30 + (peaks[idx] * 28);
            d += ` L${x.toFixed(1)},${y.toFixed(1)}`;
        }
        waveformPath.setAttribute('d', d + " Z");
    }

    function updateSpectrogram(timeOffset) {
        if (!specCanvas || !specData.length) return;
        const ctx = specCanvas.getContext('2d');
        const rows = specData.length;
        const totalCols = specData[0].length;
        const windowCols = Math.floor(totalCols * (WINDOW_DURATION / DATA_DURATION));
        const startCol = Math.floor(totalCols * (timeOffset / DATA_DURATION)) % totalCols;

        ctx.clearRect(0, 0, specCanvas.width, specCanvas.height);
        const cellW = specCanvas.width / windowCols;
        const cellH = specCanvas.height / rows;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < windowCols; c++) {
                const colIdx = (startCol + c) % totalCols;
                const val = specData[r][colIdx];
                if (val > 0.05) {
                    const rV = Math.floor(255 * Math.min(1, val * 1.5));
                    const gV = Math.floor(255 * Math.pow(val, 2));
                    const bV = Math.floor(255 * Math.pow(1 - val, 3));
                    ctx.fillStyle = `rgba(${rV}, ${gV}, ${bV}, ${val})`;
                    ctx.fillRect(c * cellW, (rows - 1 - r) * cellH, cellW + 0.5, cellH + 0.5);
                }
            }
        }
    }

    function flashNodes() {
        const nodes = document.querySelectorAll('.nn-node');
        const weights = document.querySelectorAll('.nn-weight');
        
        // Pulse weights by layer for "flow" effect
        const pulseLayer = Math.floor(Date.now() / 200) % 4;
        
        weights.forEach(w => {
            if (parseInt(w.dataset.layer) === pulseLayer && Math.random() > 0.5) {
                w.classList.add('active');
                setTimeout(() => w.classList.remove('active'), 150);
            }
        });

        nodes.forEach(n => {
            if (parseInt(n.dataset.layer) === pulseLayer && Math.random() > 0.3) {
                n.classList.add('flash');
                setTimeout(() => n.classList.remove('flash'), 150);
            }
        });
    }

    function updateChart() {
        if (!resultsChart) return;
        resultsChart.data.datasets[0].data = [
            0.94 + Math.random() * 0.04,
            0.04 + Math.random() * 0.02,
            0.01 + Math.random() * 0.01
        ];
        resultsChart.update('none');
    }

    let startTime = null;
    let lastChartUpdate = 0;
    let lastFlashUpdate = 0;

    function animate(timestamp) {
        if (!startTime) startTime = timestamp;
        const elapsed = timestamp - startTime;
        const timeOffset = (elapsed / 1000) % DATA_DURATION;
        
        updateWaveform(timeOffset);
        updateSpectrogram(timeOffset);
        
        // Throttle Node flashing to ~10fps
        if (timestamp - lastFlashUpdate > 100) {
            flashNodes();
            lastFlashUpdate = timestamp;
        }

        // Throttle Chart updating to ~5fps for readability
        if (timestamp - lastChartUpdate > 200) {
            updateChart();
            lastChartUpdate = timestamp;
        }

        const totalCycle = CYCLE_TIME * 4;
        const stepIndex = Math.floor((elapsed % totalCycle) / CYCLE_TIME);
        if (stepIndex !== currentStep - 1) {
            currentStep = stepIndex + 1;
            steps.forEach(s => s.classList.toggle('active', parseInt(s.dataset.step) === currentStep));
            panels.forEach((p, idx) => p.classList.toggle('active', idx === stepIndex));
            descriptions.forEach((d, idx) => d.classList.toggle('active', idx === stepIndex));
            if (progressBar) progressBar.style.width = (12.5 + (currentStep - 1) * 25) + '%';
        }

        requestAnimationFrame(animate);
    }

    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && !startTime) {
            requestAnimationFrame(animate);
        }
    }, { threshold: 0.1 });

    const container = document.querySelector('.workflow-viz-container');
    if (container) observer.observe(container);
});
