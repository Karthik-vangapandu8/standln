import sys
import json
import fitz  # PyMuPDF

def extract_pdf_content(pdf_path):
    try:
        doc = fitz.open(pdf_path)
        pages_text = []
        total_pages = len(doc)
        
        for page_num in range(min(total_pages, 25)):  # Limit to 25 pages max for speed
            page = doc[page_num]
            text = page.get_text("text").strip()
            if text:
                pages_text.append(f"--- PAGE {page_num + 1} ---\n{text}")
                
        doc.close()
        combined_text = "\n\n".join(pages_text)
        
        return {
            "success": True,
            "totalPages": total_pages,
            "extractedText": combined_text[:12000]  # First 12,000 characters
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No PDF path provided"}))
        sys.exit(1)
        
    pdf_file = sys.argv[1]
    result = extract_pdf_content(pdf_file)
    print(json.dumps(result))
