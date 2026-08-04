import ExcelJS from 'exceljs';

const wb = new ExcelJS.Workbook();

// Tab 1 - Closed (historical)
const closed = wb.addWorksheet('Closed');
closed.addRow(['Address', 'City', 'State', 'Zip', 'Price', 'Agent', 'MLS', 'Notes']);
closed.addRow(['1 Old St', 'Jax', 'FL', '32205', 500000, 'Nate', 'MLS001', 'closed last year']);

// Tab 2 - Sellers, color-coded
const sellers = wb.addWorksheet('Sellers');
sellers.addRow(['Address', 'City', 'State', 'Zip', 'List Price', 'Listing Agent', 'MLS #', 'Notes']);

// Red = Expired (skip)
const red = sellers.addRow(['123 Red Rd', 'Jax', 'FL', '32205', 300000, 'Alex', 'MLS100', 'expired']);
red.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } };

// Green = Sold this year
const green = sellers.addRow(['456 Green Ave', 'Jax', 'FL', '32207', 425000, 'Nate', 'MLS200', 'closed 2026-05']);
green.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } };

// White = Active
const white = sellers.addRow(['789 White Way', 'Ponte Vedra', 'FL', '32082', 850000, 'Nate', 'MLS300', 'active MLS listing']);
// no fill = white

// Yellow = Coming Soon
const yellow = sellers.addRow(['321 Yellow Ln', 'Nocatee', 'FL', '32081', 950000, 'Alex', 'MLS400', 'onboarding']);
yellow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };

// Blue = Pocket
const blue = sellers.addRow(['654 Blue Blvd', 'St Augustine', 'FL', '32086', 1200000, 'Nate', 'MLS500', 'pocket private']);
blue.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0000FF' } };

// Tab 3 - Buyers
const buyers = wb.addWorksheet('Buyers');
buyers.addRow(['Name', 'Phone', 'Email', 'Buyer Agent', 'Price Range', 'Areas', 'Property Type', 'Notes']);

// Green = Closed this year
const bClosed = buyers.addRow(['John Smith', '9041234567', 'john@ex.com', 'Alex', '$400k-500k', 'Riverside', 'SFH', 'closed May 2026']);
bClosed.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF00FF00' } };

// White = Active
buyers.addRow(['Jane Doe', '9047654321', 'jane@ex.com', 'Nate', '$600k-800k', 'Nocatee,Ponte Vedra', 'SFH', 'pre-approved, 30-day']);
buyers.addRow(['Bob Test', '', '', 'Alex', '$300k-400k', 'Jax', 'Condo', 'first-time buyer']);

await wb.xlsx.writeFile('/tmp/test-workbook.xlsx');
console.log('wrote /tmp/test-workbook.xlsx');
