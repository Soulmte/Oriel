//! Minimal, valid Office Open XML documents.
//!
//! A `.docx` is a zip with at least three parts; Word refuses anything less.
//! Entries are stored (uncompressed), which Office reads happily and keeps the
//! writer dependency-free.

use std::process::Command;

const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                0xedb8_8320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
        }
    }
    crc ^ 0xffff_ffff
}

fn write_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn write_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn zip(entries: &[(&str, &str)]) -> Vec<u8> {
    let mut locals: Vec<u8> = Vec::new();
    let mut centrals: Vec<u8> = Vec::new();
    let mut offset: u32 = 0;

    for (name, text) in entries {
        let data = text.as_bytes();
        let crc = crc32(data);
        let name_bytes = name.as_bytes();

        let mut local = Vec::new();
        write_u32(&mut local, 0x0403_4b50);
        write_u16(&mut local, 20);
        write_u16(&mut local, 0);
        write_u16(&mut local, 0); // stored
        write_u16(&mut local, 0);
        write_u16(&mut local, 0x21); // 1980-01-01
        write_u32(&mut local, crc);
        write_u32(&mut local, data.len() as u32);
        write_u32(&mut local, data.len() as u32);
        write_u16(&mut local, name_bytes.len() as u16);
        write_u16(&mut local, 0);
        local.extend_from_slice(name_bytes);

        locals.extend_from_slice(&local);
        locals.extend_from_slice(data);

        let mut central = Vec::new();
        write_u32(&mut central, 0x0201_4b50);
        write_u16(&mut central, 20);
        write_u16(&mut central, 20);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0x21);
        write_u32(&mut central, crc);
        write_u32(&mut central, data.len() as u32);
        write_u32(&mut central, data.len() as u32);
        write_u16(&mut central, name_bytes.len() as u16);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u16(&mut central, 0);
        write_u32(&mut central, 0);
        write_u32(&mut central, offset);
        central.extend_from_slice(name_bytes);
        centrals.extend_from_slice(&central);

        offset += local.len() as u32 + data.len() as u32;
    }

    let directory_start = offset;
    let directory_size = centrals.len() as u32;
    let mut end = Vec::new();
    write_u32(&mut end, 0x0605_4b50);
    write_u16(&mut end, 0);
    write_u16(&mut end, 0);
    write_u16(&mut end, entries.len() as u16);
    write_u16(&mut end, entries.len() as u16);
    write_u32(&mut end, directory_size);
    write_u32(&mut end, directory_start);
    write_u16(&mut end, 0);

    let mut out = locals;
    out.extend_from_slice(&centrals);
    out.extend_from_slice(&end);
    out
}

const CORE_PROPS: &str = concat!(
    "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" ",
    "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" ",
    "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title></dc:title><dc:creator>Oriel</dc:creator>",
    "<cp:lastModifiedBy>Oriel</cp:lastModifiedBy>",
    "<dcterms:created xsi:type=\"dcterms:W3CDTF\">2024-01-01T00:00:00Z</dcterms:created>",
    "<dcterms:modified xsi:type=\"dcterms:W3CDTF\">2024-01-01T00:00:00Z</dcterms:modified></cp:coreProperties>"
);

fn root_rels(main_part: &str) -> String {
    format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"{main_part}\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
</Relationships>"
    )
}

fn build_docx() -> Vec<u8> {
    let document = format!(
        "{XML_DECL}<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">\
<w:body><w:p/><w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/>\
<w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"851\" w:footer=\"992\" w:gutter=\"0\"/>\
</w:sectPr></w:body></w:document>"
    );
    let content_types = format!(
        "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/></Types>"
    );
    zip(&[
        ("[Content_Types].xml", &content_types),
        ("_rels/.rels", &root_rels("word/document.xml")),
        ("docProps/core.xml", &format!("{XML_DECL}{CORE_PROPS}")),
        ("word/document.xml", &document),
    ])
}

fn build_xlsx() -> Vec<u8> {
    let workbook = format!(
        "{XML_DECL}<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">\
<sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"
    );
    let workbook_rels = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>\
</Relationships>"
    );
    let sheet = format!(
        "{XML_DECL}<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData/></worksheet>"
    );
    let content_types = format!(
        "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/></Types>"
    );
    zip(&[
        ("[Content_Types].xml", &content_types),
        ("_rels/.rels", &root_rels("xl/workbook.xml")),
        ("docProps/core.xml", &format!("{XML_DECL}{CORE_PROPS}")),
        ("xl/workbook.xml", &workbook),
        ("xl/_rels/workbook.xml.rels", &workbook_rels),
        ("xl/worksheets/sheet1.xml", &sheet),
    ])
}

fn theme() -> String {
    format!(
        "{XML_DECL}<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Oriel\">\
<a:themeElements>\
<a:clrScheme name=\"Oriel\">\
<a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1><a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1>\
<a:dk2><a:srgbClr val=\"44546A\"/></a:dk2><a:lt2><a:srgbClr val=\"E7E6E6\"/></a:lt2>\
<a:accent1><a:srgbClr val=\"0A84FF\"/></a:accent1><a:accent2><a:srgbClr val=\"ED7D31\"/></a:accent2>\
<a:accent3><a:srgbClr val=\"A5A5A5\"/></a:accent3><a:accent4><a:srgbClr val=\"FFC000\"/></a:accent4>\
<a:accent5><a:srgbClr val=\"5B9BD5\"/></a:accent5><a:accent6><a:srgbClr val=\"70AD47\"/></a:accent6>\
<a:hlink><a:srgbClr val=\"0563C1\"/></a:hlink><a:folHlink><a:srgbClr val=\"954F72\"/></a:folHlink>\
</a:clrScheme>\
<a:fontScheme name=\"Oriel\">\
<a:majorFont><a:latin typeface=\"Calibri Light\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:majorFont>\
<a:minorFont><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:minorFont>\
</a:fontScheme>\
<a:fmtScheme name=\"Oriel\">\
<a:fillStyleLst>\
<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
</a:fillStyleLst>\
<a:lnStyleLst>\
<a:ln w=\"6350\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/></a:ln>\
<a:ln w=\"12700\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/></a:ln>\
<a:ln w=\"19050\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/></a:ln>\
</a:lnStyleLst>\
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>\
<a:bgFillStyleLst>\
<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
</a:bgFillStyleLst>\
</a:fmtScheme>\
</a:themeElements>\
</a:theme>"
    )
}

fn build_pptx() -> Vec<u8> {
    let empty_tree = "<p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>\
<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree>";

    let presentation = format!(
        "{XML_DECL}<p:presentation xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" saveSubsetFonts=\"1\">\
<p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>\
<p:sldIdLst><p:sldId id=\"256\" r:id=\"rId2\"/></p:sldIdLst>\
<p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>"
    );
    let presentation_rels = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide1.xml\"/>\
<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/>\
</Relationships>"
    );
    let slide_master = format!(
        "{XML_DECL}<p:sldMaster xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
<p:cSld><p:bg><p:bgRef idx=\"1001\"><a:schemeClr val=\"bg1\"/></p:bgRef></p:bg>{empty_tree}</p:cSld>\
<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" \
accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>\
<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>\
<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>"
    );
    let slide_master_rels = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/>\
</Relationships>"
    );
    let slide_layout = format!(
        "{XML_DECL}<p:sldLayout xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" type=\"blank\" preserve=\"1\">\
<p:cSld name=\"Blank\">{empty_tree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
    );
    let slide_layout_rels = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/>\
</Relationships>"
    );
    let slide = format!(
        "{XML_DECL}<p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">\
<p:cSld>{empty_tree}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    );
    let slide_rels = format!(
        "{XML_DECL}<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
</Relationships>"
    );
    let content_types = format!(
        "{XML_DECL}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>\
<Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>\
<Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>\
<Override PartName=\"/ppt/slides/slide1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>\
<Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/></Types>"
    );

    zip(&[
        ("[Content_Types].xml", &content_types),
        ("_rels/.rels", &root_rels("ppt/presentation.xml")),
        ("docProps/core.xml", &format!("{XML_DECL}{CORE_PROPS}")),
        ("ppt/presentation.xml", &presentation),
        ("ppt/_rels/presentation.xml.rels", &presentation_rels),
        ("ppt/slideMasters/slideMaster1.xml", &slide_master),
        ("ppt/slideMasters/_rels/slideMaster1.xml.rels", &slide_master_rels),
        ("ppt/slideLayouts/slideLayout1.xml", &slide_layout),
        ("ppt/slideLayouts/_rels/slideLayout1.xml.rels", &slide_layout_rels),
        ("ppt/slides/slide1.xml", &slide),
        ("ppt/slides/_rels/slide1.xml.rels", &slide_rels),
        ("ppt/theme/theme1.xml", &theme()),
    ])
}

pub fn build(template: &str) -> Option<Vec<u8>> {
    match template {
        "docx" => Some(build_docx()),
        "xlsx" => Some(build_xlsx()),
        "pptx" => Some(build_pptx()),
        _ => None,
    }
}

/// Characters the preview panel accepts from an extracted document.
const TEXT_CHAR_LIMIT: usize = 200_000;

/// Extracts the visible text of an Office Open XML document.
///
/// Word and PowerPoint files are zip packages, so 7-Zip streams the parts that
/// hold the text and the tags are stripped here. Formatting, images and tables
/// are lost on purpose: the preview panel only needs something readable, and a
/// missing 7-Zip just means the panel falls back to the file icon.
pub fn preview_text(path: &str, ext: &str) -> Option<(String, bool)> {
    let (part, paragraph) = match ext {
        "docx" | "docm" | "dotx" | "dotm" => ("word/document.xml", "</w:p>"),
        "pptx" | "pptm" | "ppsx" | "potx" => ("ppt/slides/slide*.xml", "</a:p>"),
        _ => return None,
    };

    let tool = crate::archive::tool().ok()?;
    let output = Command::new(tool)
        .args(["e", "-so", path, part])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }

    let raw = String::from_utf8_lossy(&output.stdout);
    let text = xml_to_text(&raw, paragraph);
    if text.trim().is_empty() {
        return None;
    }

    let truncated = text.chars().count() > TEXT_CHAR_LIMIT;
    Some((text.chars().take(TEXT_CHAR_LIMIT).collect(), truncated))
}

/// Turns a WordprocessingML / PresentationML part into plain text.
fn xml_to_text(xml: &str, paragraph: &str) -> String {
    let prepared = xml
        .replace(paragraph, "\n")
        .replace("<w:p/>", "\n")
        .replace("<w:p />", "\n")
        .replace("<a:p/>", "\n")
        .replace("<a:p />", "\n")
        .replace("<w:br/>", "\n")
        .replace("<w:br />", "\n")
        .replace("<w:tab/>", "\t")
        .replace("<w:tab />", "\t")
        .replace("<a:br/>", "\n")
        .replace("<a:br />", "\n");

    let mut out = String::with_capacity(prepared.len() / 2);
    let mut depth = 0u32;
    for ch in prepared.chars() {
        match ch {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }

    let decoded = out
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");

    // Word emits one empty paragraph for every visual gap; keep at most one.
    let mut cleaned = String::with_capacity(decoded.len());
    let mut blanks = 0usize;
    for line in decoded.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blanks += 1;
            if blanks > 1 {
                continue;
            }
            cleaned.push('\n');
        } else {
            blanks = 0;
            cleaned.push_str(line);
            cleaned.push('\n');
        }
    }
    cleaned.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_to_text_keeps_paragraphs_and_decodes_entities() {
        let xml = concat!(
            "<?xml version=\"1.0\"?><w:document><w:body>",
            "<w:p><w:r><w:t>Hello</w:t></w:r>",
            "<w:r><w:t xml:space=\"preserve\"> world</w:t></w:r></w:p>",
            "<w:p/><w:p><w:r><w:t>A &amp; B &lt;tag&gt;</w:t></w:r></w:p>",
            "</w:body></w:document>"
        );
        assert_eq!(
            xml_to_text(xml, "</w:p>"),
            "Hello world\n\nA & B <tag>"
        );
    }

    #[test]
    fn xml_to_text_turns_line_breaks_into_newlines() {
        let xml = "<w:p><w:r><w:t>one</w:t></w:r><w:br/><w:r><w:t>two</w:t></w:r></w:p>";
        assert_eq!(xml_to_text(xml, "</w:p>"), "one\ntwo");
    }

    #[test]
    fn xml_to_text_handles_presentation_parts() {
        let xml = concat!(
            "<p:sld><p:cSld><p:spTree><p:sp><p:txBody>",
            "<a:p><a:r><a:t>标题</a:t></a:r></a:p>",
            "<a:p><a:r><a:t>正文</a:t></a:r></a:p>",
            "</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
        );
        assert_eq!(xml_to_text(xml, "</a:p>"), "标题\n正文");
    }
}
