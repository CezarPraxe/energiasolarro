const fileInput = document.getElementById('file-input');
const resultsSection = document.getElementById('results-section');
const tableBody = document.getElementById('table-body');
const fileCountSpan = document.getElementById('file-count');
const exportBtn = document.getElementById('export-btn');
const totalRestituicaoEl = document.getElementById('total-restituicao');
const ollamaBtn = document.getElementById('ollama-btn');
const debugBtn = document.getElementById('debug-btn');

let extractedData = [];
let debugRawTexts = []; // Armazena o texto bruto para diagnóstico

// Funções Utilitárias para Matemática
function parsePtBrNum(str) {
    if (!str || str === 'N/A') return 0;
    return parseFloat(str.toString().replace(/\./g, '').replace(',', '.'));
}

function formatPtBrNum(num) {
    return num.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Extrair texto do PDF (Reconstrução visual)
async function extractTextFromPDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        
        const items = textContent.items;
        items.sort((a, b) => {
            const yA = a.transform[5];
            const yB = b.transform[5];
            // Tolerância aumentada para 12 pixels para evitar quebra de linhas na mesma tabela
            if (Math.abs(yA - yB) > 12) return yB - yA;
            return a.transform[4] - b.transform[4];
        });

        let pageText = '';
        let lastY = null;
        for (const item of items) {
            const text = item.str.trim();
            if (!text) continue;
            const currentY = item.transform[5];
            if (lastY !== null && Math.abs(lastY - currentY) > 12) {
                pageText += '\n';
            } else if (lastY !== null) {
                pageText += ' ';
            }
            pageText += text;
            lastY = currentY;
        }
        fullText += pageText + '\n';
    }
    return fullText;
}

// Parsear os dados
function parseEnergisaData(text, filename) {
    let consumoKwh = '0';
    let injecaoKwh = '0';
    let aliquota = '0';
    let baseIcms = '0';
    let mesRef = 'N/A';

    const linhas = text.split('\n');

    // 1. Mês de Referência
    const mesMatch = text.match(/(Janeiro|Fevereiro|Março|Abril|Maio|Junho|Julho|Agosto|Setembro|Outubro|Novembro|Dezembro)\s*\/\s*\d{4}/i) || text.match(/\b\d{2}\/\d{4}\b/);
    mesRef = mesMatch ? mesMatch[0] : filename; 

    // Regex para pegar qualquer número, com ou sem decimais
    const extractAllNums = (linha) => linha.match(/[−–-]?\d+(?:[.,]\d+)?/g) || [];

    // ============================================
    // ESTRATÉGIA BLINDADA: Tabela Medidor e TOTAL
    // ============================================

    // 2. Consumo (A) e Injeção (B) - Linha do Medidor (Energia ativa em kWh Energia injetada Ponta Ponta ...)
    const linhaMedidor = linhas.find(l => l.includes('Energia ativa em kWh') && l.includes('Ponta'));
    if (linhaMedidor) {
        // Cortamos a linha no "Art." (ex: Art. 12, inciso I...) para que os números de lei não se misturem
        const linhaLimpa = linhaMedidor.split(/Art\./i)[0];
        const nums = extractAllNums(linhaLimpa);
        if (nums.length >= 2) {
            consumoKwh = nums[nums.length - 2]; // Penúltimo
            injecaoKwh = nums[nums.length - 1]; // Último
        }
    } else {
        // Fallback para caso as linhas de consumo e injeção fiquem separadas
        const linhaAtiva = linhas.find(l => l.toLowerCase().includes('energia ativa em kwh'));
        if (linhaAtiva) {
            const limpa = linhaAtiva.split(/Art\./i)[0];
            const nums = extractAllNums(limpa);
            if (nums.length > 0) consumoKwh = nums[nums.length - 1];
        }
        const linhaInjetada = linhas.find(l => l.toLowerCase().includes('energia injetada'));
        if (linhaInjetada) {
            const limpa = linhaInjetada.split(/Art\./i)[0];
            const nums = extractAllNums(limpa);
            if (nums.length > 0) injecaoKwh = nums[nums.length - 1];
        }
    }

    // 3. Base ICMS (C) e Alíquota (D) - Linha: TOTAL: 246,00 0,00 495,75 96,67
    const linhaTotal = linhas.find(l => l.toLowerCase().startsWith('total:'));
    if (linhaTotal) {
        const nums = extractAllNums(linhaTotal);
        // Padrão: [0] Fatura, [1] PIS/COFINS, [2] Base ICMS, [3] Valor ICMS
        if (nums.length >= 4) {
            baseIcms = nums[2];
            
            const bIcms = parsePtBrNum(nums[2]);
            const vIcms = parsePtBrNum(nums[3]);
            if (bIcms > 0) {
                const calcAliquota = (vIcms / bIcms) * 100;
                aliquota = formatPtBrNum(calcAliquota);
            }
        }
    }

    // ============================================
    // MOTOR DE CÁLCULO: MATEMÁTICA EXATA (JS)
    // ============================================
    const A = parsePtBrNum(consumoKwh);
    let B = parsePtBrNum(injecaoKwh);
    const C = parsePtBrNum(baseIcms);
    const D = parsePtBrNum(aliquota) / 100;

    // Trava de Segurança: A energia compensada nunca pode ser maior que o próprio consumo da fatura.
    if (B > A) {
        B = A;
    }

    let valorRestituir = 0;
    if (A > 0 && B > 0) {
        const valorUnitarioBase = C / A;
        const baseIndevida = B * valorUnitarioBase;
        valorRestituir = baseIndevida * D;
    }

    return {
        mesRef,
        consumoKwh: formatPtBrNum(A),
        injecaoKwh: formatPtBrNum(B),
        baseIcms: formatPtBrNum(C),
        aliquota: aliquota,
        valorRestituir
    };
}

// Atualizar Interface
function updateUI() {
    tableBody.innerHTML = '';
    let totalSoma = 0;

    extractedData.forEach(data => {
        totalSoma += data.valorRestituir;
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${data.mesRef}</strong></td>
            <td>${data.consumoKwh}</td>
            <td>${data.injecaoKwh}</td>
            <td>R$ ${data.baseIcms}</td>
            <td>${data.aliquota}%</td>
            <td style="color: #34d399; font-weight: bold;">R$ ${formatPtBrNum(data.valorRestituir)}</td>
            <td><span class="status-badge status-success">OK</span></td>
        `;
        tableBody.appendChild(row);
    });

    fileCountSpan.textContent = extractedData.length;
    totalRestituicaoEl.textContent = `R$ ${formatPtBrNum(totalSoma)}`;
}

// Evento de Upload
fileInput.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    resultsSection.style.display = 'block';
    extractedData = []; // Limpa anteriores neste MVP
    debugRawTexts = []; // Limpa debug anterior

    for (const file of files) {
        try {
            const text = await extractTextFromPDF(file);
            debugRawTexts.push(`========== FATURA: ${file.name} ==========\n\n${text}\n\n`);
            
            const data = parseEnergisaData(text, file.name);
            extractedData.push(data);
        } catch (error) {
            console.error(error);
            debugRawTexts.push(`========== FATURA (ERRO): ${file.name} ==========\nErro: ${error.message}\n\n`);
        }
    }
    updateUI();
});

// Evento de Exportação CSV
exportBtn.addEventListener('click', () => {
    if (extractedData.length === 0) return;
    let csvContent = "Mes/Fatura;Consumo (kWh);Injecao (kWh);Base ICMS (R$);Aliquota (%);Valor Restituir (R$)\n";
    extractedData.forEach(r => {
        csvContent += `${r.mesRef};${r.consumoKwh};${r.injecaoKwh};${r.baseIcms};${r.aliquota};${formatPtBrNum(r.valorRestituir)}\n`;
    });
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auditoria_icms_${new Date().getTime()}.csv`;
    a.click();
});

// Evento de Download do Raio-X (Debug)
debugBtn.addEventListener('click', () => {
    if (debugRawTexts.length === 0) {
        alert('Carregue os PDFs primeiro antes de baixar o Raio-X.');
        return;
    }
    const blob = new Blob([debugRawTexts.join('\n')], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `raiox_faturas_${new Date().getTime()}.txt`;
    a.click();
});

// ============================================
// INTEGRAÇÃO COM OLLAMA (GEMMA 3)
// ============================================
const modal = document.getElementById('ollama-modal');
const closeBtn = document.querySelector('.close-btn');
const resultArea = document.getElementById('ollama-result');
const loadingIndicator = document.getElementById('ollama-loading');

closeBtn.onclick = () => modal.style.display = "none";
window.onclick = (e) => { if (e.target == modal) modal.style.display = "none"; }

ollamaBtn.addEventListener('click', async () => {
    if (extractedData.length === 0) {
        alert("Adicione faturas primeiro!");
        return;
    }

    modal.style.display = "block";
    loadingIndicator.style.display = "block";
    resultArea.style.display = "none";
    resultArea.value = "";

    const totalCalculado = totalRestituicaoEl.textContent;
    
    // Constrói o Prompt com os dados exatos do Javascript
    const prompt = `Você é um assistente jurídico tributário.
Os cálculos de ressarcimento de ICMS sobre energia injetada (TUSD/TE) foram auditados com precisão matemática pelo sistema:
Total de Faturas Auditadas: ${extractedData.length}
Valor Total Indevido a Restituir: ${totalCalculado}

Escreva um breve e direto Parecer Técnico (máximo 3 parágrafos) atestando que os cálculos foram verificados, que a cobrança de ICMS sobre a energia compensada fere o entendimento do STJ (TUSD na energia injetada), e que o cliente tem o direito ao ressarcimento do valor exato de ${totalCalculado}. Não faça contas, use apenas o valor informado.`;

    try {
        const response = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'gemma3:4b',
                prompt: prompt,
                stream: false
            })
        });

        const json = await response.json();
        
        loadingIndicator.style.display = "none";
        resultArea.style.display = "block";
        resultArea.value = json.response;

    } catch (e) {
        loadingIndicator.style.display = "none";
        resultArea.style.display = "block";
        resultArea.value = "Erro ao conectar com Ollama local (http://localhost:11434). Certifique-se que o Ollama está rodando na sua máquina e o modelo gemma3:4b está instalado.\n\nDetalhes do Erro: " + e.message;
    }
});
