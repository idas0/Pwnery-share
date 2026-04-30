export interface StockData {
  ProductID: string;
  SKU: string;
  DistributorID: string;
  Stock: number;
  Cost: number;
  DistributorSKU: string;
}

export interface DistributorInfo {
  ID: string;
  Name: string;
  Website: string;
}

/**
 * Parses pipe-delimited CSV data from Stock In The Channel
 * Expected format: ProductID|DistributorID|Stock|Cost|DistributorSKU|DistributorCategory|ETA|BrandSKU
 */
export function parseStockData(csvContent: string): StockData[] {
  const lines = csvContent.split('\n').filter(line => line.trim() !== '' && !line.startsWith(';'));
  const stockData: StockData[] = [];

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith(';')) {
      continue;
    }

    const parts = trimmedLine.split('|');
    
    // Validate we have at least the required fields (first 4 plus DistributorSKU at index 4 and BrandSKU at index 7)
    if (parts.length < 8) {
      console.warn(`Skipping invalid line (insufficient columns): ${trimmedLine}`);
      continue;
    }

    const productID = parts[0]?.trim();
    const distributorID = parts[1]?.trim();
    const stock = parts[2]?.trim();
    const cost = parts[3]?.trim();
    const distributorSKU = parts[4]?.trim();
    const brandSKU = parts[7]?.trim();

    const isHeaderLine =
      productID?.toLowerCase() === 'productid' &&
      distributorID?.toLowerCase() === 'distributorid' &&
      stock?.toLowerCase() === 'stock' &&
      cost?.toLowerCase() === 'cost';

    if (isHeaderLine) {
      continue;
    }

    // Validate required fields
    if (!productID || !distributorID || !stock || !cost || !distributorSKU || !brandSKU) {
      console.warn(`Skipping invalid line (missing required fields): ${trimmedLine}`);
      continue;
    }

    // Parse numeric values
    const stockNum = parseFloat(stock);
    const costNum = parseFloat(cost);

    if (isNaN(stockNum) || isNaN(costNum)) {
      console.warn(`Skipping invalid line (invalid numeric values): ${trimmedLine}`);
      continue;
    }

    stockData.push({
      ProductID: productID,
      SKU: brandSKU,
      DistributorID: distributorID,
      Stock: stockNum,
      Cost: costNum,
      DistributorSKU: distributorSKU
    });
  }

  return stockData;
}

export function parseDistributorData(csvContent: string): DistributorInfo[] {
  // Split lines and remove empty lines or lines starting with comments if any
  const lines = csvContent.split('\n').filter(line => line.trim() !== '');
  const distributorData: DistributorInfo[] = [];

  // We start at index 1 to skip the header row "ID|Name|Website"
  for (let i = 1; i < lines.length; i++) {
    const trimmedLine = lines[i].trim();
    
    if (!trimmedLine) {
      continue;
    }

    const parts = trimmedLine.split('|');
    
    // Validate we have the 3 required columns
    if (parts.length < 3) {
      console.warn(`Skipping invalid line (insufficient columns): ${trimmedLine}`);
      continue;
    }

    const id = parts[0]?.trim();
    const name = parts[1]?.trim();
    const website = parts[2]?.trim();

    // Validate fields are not empty
    if (!id || !name || !website) {
      console.warn(`Skipping invalid line (missing fields): ${trimmedLine}`);
      continue;
    }

    distributorData.push({
      ID: id,
      Name: name,
      Website: website,
    });
  }

  return distributorData;
}