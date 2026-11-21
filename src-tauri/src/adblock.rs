//! Ad blocking for the Web tabs: requests to known ad / tracking servers are answered locally
//! (empty 403) and never leave the machine. A domain also covers its subdomains.

use std::{collections::HashSet, sync::LazyLock};

const DOMAINS: &[&str] = &[
    // Google ads
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "googletagservices.com",
    "adservice.google.com",
    "google-analytics.com",
    // ad exchanges, networks, measurement
    "adnxs.com",
    "adsrvr.org",
    "criteo.com",
    "criteo.net",
    "taboola.com",
    "outbrain.com",
    "pubmatic.com",
    "rubiconproject.com",
    "openx.net",
    "casalemedia.com",
    "indexww.com",
    "amazon-adsystem.com",
    "advertising.com",
    "adform.net",
    "smartadserver.com",
    "yieldmo.com",
    "teads.tv",
    "sharethrough.com",
    "33across.com",
    "bidswitch.net",
    "contextweb.com",
    "lijit.com",
    "sovrn.com",
    "media.net",
    "adroll.com",
    "moatads.com",
    "adsafeprotected.com",
    "doubleverify.com",
    "scorecardresearch.com",
    "quantserve.com",
    "zedo.com",
    "revcontent.com",
    "mgid.com",
    "bidvertiser.com",
    "ads-twitter.com",
    "ads.linkedin.com",
    "an.facebook.com",
    "an.yandex.ru",
    "mc.yandex.ru",
    // pop-ups / pop-unders
    "propellerads.com",
    "popads.net",
    "popcash.net",
    "adsterra.com",
    "exoclick.com",
    "juicyads.com",
    "trafficjunky.net",
    "hilltopads.net",
    "onclickads.net",
    "adcash.com",
    "yllix.com",
    // Vietnamese ad networks
    "admicro.vn",
    "adtima.vn",
    "adtimaserver.vn",
    "eclick.vn",
    "ambientplatform.vn",
    "yomedia.vn",
    "ants.vn",
    "aiactiv.io",
];

static SET: LazyLock<HashSet<&'static str>> = LazyLock::new(|| DOMAINS.iter().copied().collect());

/// The URL's host, or one of its parent domains, serves ads.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_ad(url: &str) -> bool {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = host.split(':').next().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
    let mut h = host.as_str();
    loop {
        if SET.contains(h) {
            return true;
        }
        match h.split_once('.') {
            Some((_, parent)) if parent.contains('.') => h = parent,
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_ad;

    #[test]
    fn matches_domain_and_subdomains_only() {
        assert!(is_ad("https://securepubads.g.doubleclick.net/tag/js/gpt.js"));
        assert!(is_ad("https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=x"));
        assert!(is_ad("https://media1.admicro.vn/core/admcore.js"));
        assert!(is_ad("https://ADSERVICE.google.com:443/x"));
        assert!(!is_ad("https://www.google.com/search?q=doubleclick.net"));
        assert!(!is_ad("https://notdoubleclick.net/"));
        assert!(!is_ad("https://www.facebook.com/"));
        assert!(!is_ad("https://vnexpress.net/"));
        assert!(!is_ad("about:blank"));
    }
}
